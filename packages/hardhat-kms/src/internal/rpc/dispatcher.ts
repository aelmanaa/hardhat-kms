import {
  rpcAddress,
  rpcAny,
  rpcData,
  validateParams,
} from "@nomicfoundation/hardhat-zod-utils/rpc";
import type { HookContext } from "hardhat/types/hooks";
import type { JsonRpcRequest, JsonRpcResponse } from "hardhat/types/providers";

import type { KmsKeyConfig } from "../../types.ts";
import { toChecksumAddress } from "../crypto/address.ts";
import { InvalidTypedDataError, parseTypedData, type TypedData } from "../crypto/digests.ts";
import { kmsDebug } from "../debug.ts";
import { errorName, kmsError } from "../errors.ts";
import { parseAwsKeyId } from "../providers/aws/key-id.ts";
import type { SignerCache } from "../signer/key-cache.ts";
import type { KmsSigner } from "../signer/kms-signer.ts";
import { type ConnectionChain, parseChainId } from "./chain-id.ts";

const log = kmsDebug("rpc");

/** The KMS keys of one network connection. */
export interface NetworkKeys {
  /** The network's name. */
  name: string;
  /** The network's `kmsAccounts`, in order. */
  config: readonly KmsKeyConfig[];
  /** The keys chosen with `--kms`, when this is the selected network. */
  commandLine: readonly KmsKeyConfig[];
}

/**
 * What makes two keys of a first-party provider the same KMS key: the identifier, read the way
 * the adapter reads it, plus, for an AWS key id or alias, the settings that decide where it is
 * looked up. Returns `undefined` for keys of other providers.
 */
async function keyIdentity(key: KmsKeyConfig): Promise<string | undefined> {
  if ("keyVersionName" in key) {
    return `gcp\0${await key.keyVersionName.get()}`;
  }
  if (key.provider === "azure") {
    return `azure\0${await key.keyId.get()}`;
  }
  if (key.provider === "aws") {
    const id = await key.keyId.get();
    // An ARN names its account and region. A key id or alias names a key only together with the
    // region, profile and endpoint it is looked up in.
    return parseAwsKeyId(id)?.kind === "keyArn" || parseAwsKeyId(id)?.kind === "aliasArn"
      ? `aws\0${id}`
      : `aws\0${id}\0${key.region ?? ""}\0${key.profile ?? ""}\0${key.endpoint ?? ""}`;
  }
  return undefined;
}

/** The methods the dispatcher looks at; every other method passes through (rule 1). */
const ACCOUNT_METHODS = new Set(["eth_accounts", "eth_requestAccounts"]);
const TRANSACTION_METHODS = new Set(["eth_sendTransaction", "eth_signTransaction"]);

/** Reads a request's positional params; anything else counts as no params. */
function paramsOf(request: JsonRpcRequest): unknown[] {
  return Array.isArray(request.params) ? request.params : [];
}

/** An address param as lowercase hex, or `undefined` if it is not an address. */
function addressParam(value: unknown): string | undefined {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) {
    return value.toLowerCase();
  }
  if (value instanceof Uint8Array && value.length === 20) {
    return `0x${Buffer.from(value).toString("hex")}`;
  }
  return undefined;
}

function response(request: JsonRpcRequest, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: request.id, result };
}

/**
 * The KMS accounts of one network connection: their addresses and signers. An address comes from
 * the key's `address` pin when it has one, with no KMS call; otherwise from the key, and the
 * lookups run in parallel on first use. A failed lookup is not kept, so the next request retries.
 */
export class ConnectionAccounts {
  readonly #context: HookContext;
  readonly #cache: SignerCache;
  readonly #network: NetworkKeys;
  readonly #keys: readonly KmsKeyConfig[];
  #addresses: Promise<Map<string, KmsKeyConfig>> | undefined;

  /**
   * @param context - The Hardhat runtime.
   * @param cache - The runtime's signers.
   * @param network - The connection's KMS keys.
   */
  public constructor(context: HookContext, cache: SignerCache, network: NetworkKeys) {
    this.#context = context;
    this.#cache = cache;
    this.#network = network;
    this.#keys = [...network.config, ...network.commandLine];
  }

  /** Whether the connection has KMS keys at all. */
  public get isEmpty(): boolean {
    return this.#keys.length === 0;
  }

  /**
   * Returns the KMS addresses, checksummed, in key order and without duplicates.
   *
   * @returns The addresses.
   */
  public async addresses(): Promise<string[]> {
    const byAddress = await this.#resolve();
    return [...byAddress.keys()].map((address) => toChecksumAddress(address));
  }

  /**
   * Tells whether an address is one of the KMS accounts.
   *
   * @param address - A lowercase address.
   * @returns Whether it is.
   */
  public async isKmsAccount(address: string): Promise<boolean> {
    return (await this.#resolve()).has(address);
  }

  /**
   * Signs with the KMS account at an address.
   *
   * @param address - A lowercase address.
   * @param sign - What to do with the account's signer.
   * @returns What `sign` returns, or `undefined` if the address is not a KMS account.
   */
  public async withSigner<T>(
    address: string,
    sign: (signer: KmsSigner) => Promise<T>,
  ): Promise<{ result: T } | undefined> {
    const key = (await this.#resolve()).get(address);
    return key === undefined
      ? undefined
      : { result: await this.#cache.withSigner(this.#context, key, sign) };
  }

  async #resolve(): Promise<Map<string, KmsKeyConfig>> {
    this.#addresses ??= this.#lookUp().catch((error: unknown) => {
      this.#addresses = undefined;
      throw error;
    });
    return await this.#addresses;
  }

  async #lookUp(): Promise<Map<string, KmsKeyConfig>> {
    await this.#checkCommandLineKeys();
    const resolved = await Promise.all(
      this.#keys.map(async (key) => ({
        key,
        address:
          key.address ??
          (await this.#cache.withSigner(
            this.#context,
            key,
            async (signer) => await signer.getAddress(),
          )),
      })),
    );
    const byAddress = new Map<string, KmsKeyConfig>();
    for (const { key, address } of resolved) {
      const normalized = address.toLowerCase();
      const existing = byAddress.get(normalized);
      if (existing !== undefined) {
        throw kmsError(
          `${key.name} and ${existing.name} are the same account (${toChecksumAddress(address)}); list each key once`,
          { operation: "load accounts" },
        );
      }
      byAddress.set(normalized, key);
    }
    log("accounts: %s", [...byAddress.values()].map((key) => key.displayId).join(", "));
    return byAddress;
  }

  /**
   * Refuses a `--kms` key that names the same KMS key as one of the network's config keys, with
   * both names and no values (decision 0008). Keys that name one key differently, such as an
   * alias and an ARN, are caught when their addresses are compared.
   */
  async #checkCommandLineKeys(): Promise<void> {
    const { config, commandLine, name } = this.#network;
    if (commandLine.length === 0) {
      return;
    }
    // A pinned config key is not read here: its pin already gives its address, and reading it
    // could ask for an unset variable or a keystore password the run would not otherwise need.
    const configIds = await Promise.all(
      config.map(async (key) => (key.address === undefined ? await keyIdentity(key) : undefined)),
    );
    for (const key of commandLine) {
      const id = await keyIdentity(key);
      const index = id === undefined ? -1 : configIds.indexOf(id);
      const existing = config[index];
      if (existing !== undefined) {
        const path = `networks.${name}.kmsAccounts[${index}]`;
        // An inline key is named after its place in the network.
        const named =
          existing.name === `${name}.kmsAccounts[${index}]` ? "" : ` ("${existing.name}")`;
        throw kmsError(`${key.name} is already ${path}${named}; use one of them`, {
          provider: key.provider,
          operation: "load accounts",
        });
      }
    }
  }
}

type Next = (request: JsonRpcRequest) => Promise<JsonRpcResponse>;

/** What the typed-data chain check needs from the connection and the config. */
export interface TypedDataPolicy {
  /** The connection's chain. */
  chain: ConnectionChain;
  /** `kms.allowCrossChainTypedData`: sign typed data for another chain. */
  allowCrossChainTypedData: boolean;
}

/**
 * Handles one JSON-RPC request for a connection with KMS accounts: lists the accounts, and signs
 * messages and typed data for them. Everything else, including requests for other addresses, goes
 * to `next`, which is called at most once (rule 2).
 *
 * @param accounts - The connection's KMS accounts.
 * @param request - The request.
 * @param next - The rest of the chain.
 * @param policy - The typed-data chain check's inputs.
 * @returns The response.
 */
export async function dispatch(
  accounts: ConnectionAccounts,
  request: JsonRpcRequest,
  next: Next,
  policy: TypedDataPolicy,
): Promise<JsonRpcResponse> {
  if (accounts.isEmpty) {
    return await next(request);
  }
  const params = paramsOf(request);
  if (ACCOUNT_METHODS.has(request.method)) {
    return response(request, await listAccounts(accounts, request, next));
  }
  if (request.method === "eth_sign") {
    const signed = await signFor(accounts, params[0], async (signer) => {
      const [, data] = validateParams(params, rpcAddress, rpcData);
      return await signer.signPersonalMessage(data);
    });
    if (signed !== undefined) {
      return response(request, signed.result);
    }
  } else if (request.method === "personal_sign") {
    const signed = await signFor(accounts, params[1], async (signer) => {
      const [data] = validateParams(params, rpcData, rpcAddress);
      return await signer.signPersonalMessage(data);
    });
    if (signed !== undefined) {
      return response(request, signed.result);
    }
  } else if (request.method === "eth_signTypedData_v4") {
    const signed = await signFor(accounts, params[0], async (signer) => {
      const data: unknown = validateParams(params, rpcAddress, rpcAny)[1];
      return await signTypedData(signer, data, policy);
    });
    if (signed !== undefined) {
      return response(request, signed.result);
    }
  } else if (TRANSACTION_METHODS.has(request.method)) {
    const transaction: unknown = params[0];
    const from: unknown =
      typeof transaction === "object" && transaction !== null
        ? Reflect.get(transaction, "from")
        : undefined;
    const address = addressParam(from);
    if (address !== undefined && (await accounts.isKmsAccount(address))) {
      throw kmsError(
        `${request.method} from KMS accounts is not available yet (https://github.com/aelmanaa/hardhat-kms/issues/24); messages and typed data can be signed`,
        { operation: request.method },
      );
    }
  }
  return await next(request);
}

/**
 * Signs with the KMS account named by an address param.
 *
 * @returns The result, or `undefined` when the param is not a KMS account's address.
 */
async function signFor<T>(
  accounts: ConnectionAccounts,
  value: unknown,
  sign: (signer: KmsSigner) => Promise<T>,
): Promise<{ result: T } | undefined> {
  const address = addressParam(value);
  return address === undefined ? undefined : await accounts.withSigner(address, sign);
}

/**
 * The network's own accounts followed by the KMS addresses. If the network's own list fails, only
 * the KMS addresses are returned: a remote node without accounts often rejects `eth_accounts`.
 */
async function listAccounts(
  accounts: ConnectionAccounts,
  request: JsonRpcRequest,
  next: Next,
): Promise<string[]> {
  let own: string[] = [];
  try {
    // eth_requestAccounts means eth_accounts here, as in Hardhat's local accounts; many nodes,
    // including Hardhat's simulated network, only implement eth_accounts.
    const downstream = await next({ ...request, method: "eth_accounts" });
    if ("result" in downstream && Array.isArray(downstream.result)) {
      own = downstream.result.filter((item) => typeof item === "string");
    }
  } catch (error) {
    // Only the class name: a node's error text can include its URL, and with it an API key.
    log(
      "%s failed downstream (%s); listing the KMS accounts only",
      request.method,
      errorName(error),
    );
  }
  const seen = new Set(own.map((address) => address.toLowerCase()));
  const kms = (await accounts.addresses()).filter((address) => !seen.has(address.toLowerCase()));
  return [...own, ...kms];
}

async function signTypedData(
  signer: KmsSigner,
  data: unknown,
  policy: TypedDataPolicy,
): Promise<string> {
  let typedData: unknown = data;
  if (typeof data === "string") {
    try {
      typedData = JSON.parse(data);
    } catch {
      throw kmsError("the typed data is not valid JSON", { operation: "eth_signTypedData_v4" });
    }
  }
  let parsed: TypedData;
  try {
    parsed = parseTypedData(typedData);
  } catch (error) {
    if (!(error instanceof InvalidTypedDataError)) {
      throw error;
    }
    // Our own message about the user's typed data: safe to show, and the user's to fix.
    throw kmsError(`the typed data is invalid: ${error.message}`, {
      operation: "eth_signTypedData_v4",
    });
  }
  await checkTypedDataChain(parsed, policy);
  return await signer.signTypedData(parsed);
}

/**
 * Refuses typed data for another chain than the connection's, unless the config allows it. Typed
 * data without `domain.chainId` is signed, as MetaMask, Hardhat and Foundry do: it is valid
 * EIP-712, and off-chain and cross-chain schemes rely on it.
 */
async function checkTypedDataChain(typedData: TypedData, policy: TypedDataPolicy): Promise<void> {
  const domainChain = parseChainId(
    typedData.domain.chainId,
    "domain.chainId",
    "eth_signTypedData_v4",
  );
  if (domainChain === undefined) {
    log("typed data without domain.chainId: the signature is valid on every chain");
    return;
  }
  if (policy.allowCrossChainTypedData) {
    return;
  }
  const chain = await policy.chain.chainId();
  if (domainChain !== chain) {
    throw kmsError(
      `the typed data is for chain ${domainChain}, but this network is chain ${chain}. Set \`kms.allowCrossChainTypedData: true\` to sign typed data for other chains`,
      { operation: "eth_signTypedData_v4" },
    );
  }
}
