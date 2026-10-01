import { isObject } from "@nomicfoundation/hardhat-utils/lang";
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
import {
  canonicalJson,
  type ConnectionSends,
  RETRY_TTL_MS,
  SendOutcomeUnknownError,
  type SentTransaction,
  withSendLock,
} from "./send-guard.ts";
import { notPlainData, type TransactionFiller } from "./transaction-filler.ts";
import { signTransaction } from "./transactions.ts";

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
    const key = await this.keyFor(address);
    return key === undefined ? undefined : { result: await this.signWith(key, sign) };
  }

  /**
   * Returns the key of the KMS account at an address.
   *
   * @param address - A lowercase address.
   * @returns The key, or `undefined` if the address is not a KMS account.
   */
  public async keyFor(address: string): Promise<KmsKeyConfig | undefined> {
    return (await this.#resolve()).get(address);
  }

  /**
   * Signs with a key's signer. The idle close waits until `sign` has finished.
   *
   * @param key - A key from {@link ConnectionAccounts.keyFor}.
   * @param sign - What to do with the key's signer.
   * @returns What `sign` returns.
   */
  public async signWith<T>(key: KmsKeyConfig, sign: (signer: KmsSigner) => Promise<T>): Promise<T> {
    return await this.#cache.withSigner(this.#context, key, sign);
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

/** What signing transactions needs from the connection. */
export interface ConnectionTransactions {
  /** Returns the connection's transaction filler. */
  filler(): TransactionFiller;
  /**
   * The sender Hardhat's sender handlers would give a transaction without `from`: the network's
   * `from`, else the first account of `eth_accounts`.
   */
  defaultSender(): Promise<unknown>;
  /** Returns the connection's chain id. */
  chainId(): Promise<bigint>;
  /** Returns the connection's send state: nonce high-water marks and retry entries. */
  sends(): ConnectionSends;
  /** Sends a read request on the connection, through the whole hook chain. */
  request(method: string, params: unknown[]): Promise<unknown>;
}

/**
 * Handles one JSON-RPC request for a connection with KMS accounts: lists the accounts, and signs
 * transactions, messages and typed data for them. Everything else, including requests for other
 * addresses, goes to `next`, which is called at most once (rule 2).
 *
 * @param accounts - The connection's KMS accounts.
 * @param request - The request.
 * @param next - The rest of the chain.
 * @param policy - The typed-data chain check's inputs.
 * @param transactions - The connection's filler and default sender.
 * @returns The response.
 */
export async function dispatch(
  accounts: ConnectionAccounts,
  request: JsonRpcRequest,
  next: Next,
  policy: TypedDataPolicy,
  transactions: ConnectionTransactions,
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
    const outcome = await kmsTransactionOf(accounts, request.method, params, transactions);
    if ("kms" in outcome && request.method === "eth_sendTransaction") {
      return await sendTransaction(accounts, request, outcome.kms, transactions, next);
    }
    if ("kms" in outcome) {
      // eth_signTransaction takes no lock and leaves the high-water mark alone (rule 5).
      const { key, address, params: signParams } = outcome.kms;
      const signed = await accounts.signWith(
        key,
        async (signer) =>
          await signTransaction(signer, {
            filler: transactions.filler(),
            method: request.method,
            params: signParams,
            from: address,
          }),
      );
      return response(request, signed.raw);
    }
    if (outcome.params !== undefined) {
      return await next({ ...request, params: outcome.params });
    }
  }
  return await next(request);
}

/** A transaction to sign with a KMS account. */
interface KmsTransaction {
  /** The account's key. */
  key: KmsKeyConfig;
  /** The account's lowercase address. */
  address: string;
  /** The copied params, with `from` set to the account. */
  params: unknown[];
  /** The copied params as the caller sent them, for the retry key. */
  callerParams: unknown[];
  /** Whether the caller chose the nonce. */
  callerNonce: boolean;
}

/**
 * What happens to a transaction request: a KMS account signs it, or it goes on to the rest of the
 * chain, either unchanged (`params` undefined) or with the sender the plugin chose.
 */
type TransactionOutcome = { kms: KmsTransaction } | { params: unknown[] | undefined };

/**
 * Finds the KMS account that signs a transaction, and copies the transaction.
 *
 * The transaction is copied before the first `await`, so a caller that changes its object
 * meanwhile cannot change what is signed. A transaction that cannot be copied is refused only
 * when its sender is a KMS account; any other request passes on as it came (rule 1).
 *
 * A transaction without `from` gets the sender Hardhat would give it, and goes on with that sender
 * set even when it is not a KMS account: Hardhat's automatic sender caches its first answer per
 * connection, and may otherwise pick a KMS address the plugin did not see, so the transaction
 * would reach the node unsigned. The sender is set on a shallow copy of the caller's transaction.
 *
 * @returns The KMS transaction, or the params to pass on.
 */
async function kmsTransactionOf(
  accounts: ConnectionAccounts,
  method: string,
  params: unknown[],
  transactions: ConnectionTransactions,
): Promise<TransactionOutcome> {
  const [original, ...originalRest] = params;
  if (!isObject(original)) {
    return { params: undefined };
  }
  const requestedFrom: unknown = original.from;
  let copy: { transaction: Record<string, unknown>; rest: unknown[] } | undefined;
  try {
    copy = structuredClone({ transaction: original, rest: originalRest });
  } catch {
    copy = undefined;
  }
  let from = requestedFrom;
  let forward: unknown[] | undefined;
  if (from === undefined) {
    from = await transactions.defaultSender();
    if (from === undefined) {
      return { params: undefined };
    }
    forward = [{ ...original, from }, ...originalRest];
  }
  const address = addressParam(from);
  if (address === undefined) {
    return { params: forward };
  }
  if (copy === undefined) {
    if (await accounts.isKmsAccount(address)) {
      throw notPlainData(method);
    }
    return { params: forward };
  }
  const key = await accounts.keyFor(address);
  if (key === undefined) {
    return { params: forward };
  }
  const { transaction, rest } = copy;
  return {
    kms: {
      key,
      address,
      params: [{ ...transaction, from }, ...rest],
      callerParams: [transaction, ...rest],
      callerNonce: transaction.nonce !== undefined,
    },
  };
}

/**
 * Sends a KMS account's transaction under the send lock for its chain and address (rule 4).
 * Inside the lock: a retry entry for the same request is sent again; otherwise the transaction is
 * filled and signed inside `signWith`, then broadcast once with `next`, after `signWith` has
 * returned, so the idle close never waits on the node.
 */
async function sendTransaction(
  accounts: ConnectionAccounts,
  request: JsonRpcRequest,
  kms: KmsTransaction,
  transactions: ConnectionTransactions,
  next: Next,
): Promise<JsonRpcResponse> {
  const chainId = await transactions.chainId();
  const sends = transactions.sends();
  const { address } = kms;
  const callerParams = canonicalJson(kms.callerParams);
  const retryKey =
    callerParams === undefined ? undefined : `${chainId}\0${address}\0${callerParams}`;
  return await withSendLock(`${chainId}:${address}`, async () => {
    const retry = retryKey === undefined ? undefined : sends.takeRetry(retryKey);
    if (retry !== undefined) {
      log("sending transaction %s again for a retried request", retry.hash);
      return await broadcast(request, retry, { address, sends, retryKey, next, resend: true });
    }
    if (!kms.callerNonce) {
      await settleUncertain(address, sends, transactions);
    }
    const signed = await accounts.signWith(
      kms.key,
      async (signer) =>
        await signTransaction(signer, {
          filler: transactions.filler(),
          method: request.method,
          params: kms.params,
          from: address,
          chooseNonce: kms.callerNonce ? undefined : (pending) => sends.nonceFor(address, pending),
        }),
    );
    return await broadcast(request, signed, { address, sends, retryKey, next, resend: false });
  });
}

/**
 * Asks the node about the sender's last transaction whose broadcast got no answer. If the node
 * has it, the high-water mark rises to its nonce, so a node whose pending count lags cannot give
 * that nonce to the next send, which could replace the first transaction. If the node does not
 * have it, or the lookup fails, the mark stays and the node's pending count decides.
 */
async function settleUncertain(
  address: string,
  sends: ConnectionSends,
  transactions: ConnectionTransactions,
): Promise<void> {
  const uncertain = sends.takeUncertain(address);
  if (uncertain === undefined) {
    return;
  }
  let known = false;
  try {
    const found = await transactions.request("eth_getTransactionByHash", [uncertain.hash]);
    known = isObject(found);
  } catch (error) {
    log("looking up transaction %s failed (%s)", uncertain.hash, errorName(error));
  }
  log("transaction %s is %s the node", uncertain.hash, known ? "known to" : "not known to");
  if (known) {
    sends.recordSent(address, uncertain.nonce);
  }
}

/** What a broadcast needs besides the request and the transaction. */
interface BroadcastContext {
  address: string;
  sends: ConnectionSends;
  /** The retry key, or `undefined` when the params cannot be serialized for one. */
  retryKey: string | undefined;
  next: Next;
  /** Whether this sends a retry entry's bytes again. */
  resend: boolean;
}

/**
 * Tells whether a node refused a raw transaction because it already has it. The message must
 * start with what a client says: "already known" (Geth, Reth, Erigon), "AlreadyKnown"
 * (Nethermind) or "known transaction" (older Geth, and Hardhat's EDR as "Known transaction:
 * <hash>"). A message
 * such as "unknown transaction type" does not match.
 */
export function isAlreadyKnown(message: string): boolean {
  return /^\s*(?:already known\b|alreadyknown\b|known transaction\b)/i.test(message);
}

/**
 * Tells whether a thrown error is a node's answer. Hardhat's errors for node answers carry a
 * numeric `code`: `ProviderError` and its subclasses, and `SolidityError` (code 3) for a reverted
 * transaction. Its `UnknownError` (code -1) wraps a failed HTTP request, and its `HardhatError`
 * for a refused connection or a timeout has no `code`; neither is an answer.
 *
 * @returns The error as a record when it is a node's answer, else `undefined`.
 */
function nodeAnswer(error: unknown): Record<string, unknown> | undefined {
  return isObject(error) && typeof error.code === "number" && error.code !== -1 ? error : undefined;
}

/**
 * The hash of a transaction the node ran although its answer is an error, as a node that mines
 * at once reports for a reverted transaction: in `transactionHash` (Hardhat's `SolidityError`) or
 * in `data.transactionHash` (the JSON-RPC error data of Hardhat's nodes).
 */
function minedHashOf(error: Record<string, unknown>): string | undefined {
  if (typeof error.transactionHash === "string") {
    return error.transactionHash;
  }
  const { data } = error;
  return isObject(data) && typeof data.transactionHash === "string"
    ? data.transactionHash
    : undefined;
}

/**
 * Sends a signed transaction with exactly one `next(eth_sendRawTransaction)`.
 *
 * - The node accepts it: its answer is returned as it is.
 * - The node answers with an error (returned, or thrown with a JSON-RPC code): the answer is
 *   returned or thrown as it is, and no retry entry is kept. If the error says the transaction
 *   was mined anyway, its nonce counts as used. When bytes are sent again, "already known" counts
 *   as success.
 * - No answer (a thrown error without a JSON-RPC code, such as a timeout): the outcome is
 *   unknown. The transaction is kept for one retry of the same request and for a lookup before
 *   the sender's next send, and a {@link SendOutcomeUnknownError} is thrown.
 */
async function broadcast(
  request: JsonRpcRequest,
  transaction: SentTransaction,
  context: BroadcastContext,
): Promise<JsonRpcResponse> {
  const { address, sends, retryKey, next, resend } = context;
  const accepted = (): JsonRpcResponse => {
    sends.recordSent(address, transaction.nonce);
    return response(request, transaction.hash);
  };
  const answered = (error: Record<string, unknown>): void => {
    sends.settleUncertain(address, transaction.hash);
    if (minedHashOf(error) !== undefined) {
      sends.recordSent(address, transaction.nonce);
    }
  };
  let thrown: unknown;
  try {
    const answer = await next({
      ...request,
      method: "eth_sendRawTransaction",
      params: [transaction.raw],
    });
    sends.settleUncertain(address, transaction.hash);
    if (!("error" in answer)) {
      sends.recordSent(address, transaction.nonce);
      return answer;
    }
    if (resend && isAlreadyKnown(answer.error.message)) {
      return accepted();
    }
    answered(answer.error);
    return answer;
  } catch (error) {
    thrown = error;
  }
  const thrownAnswer = nodeAnswer(thrown);
  if (thrownAnswer !== undefined) {
    if (
      resend &&
      typeof thrownAnswer.message === "string" &&
      isAlreadyKnown(thrownAnswer.message)
    ) {
      sends.settleUncertain(address, transaction.hash);
      return accepted();
    }
    answered(thrownAnswer);
    throw thrown;
  }
  if (retryKey !== undefined) {
    sends.rememberFailure(retryKey, transaction);
  }
  sends.rememberUncertain(address, transaction);
  // Only the class name: a transport error's text can include the node's URL.
  const cause = errorName(thrown);
  log("sending transaction %s got no answer (%s)", transaction.hash, cause);
  throw new SendOutcomeUnknownError(
    `${request.method}: transaction ${transaction.hash} was handed to the node, but no answer came back (${cause}). It may still be mined: look it up by its hash before sending another transaction. Repeating the same request within ${RETRY_TTL_MS / 1000} s sends the same transaction again.`,
    transaction.hash,
  );
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
