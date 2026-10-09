import { keccak_256 } from "@noble/hashes/sha3.js";
import { HardhatError } from "@nomicfoundation/hardhat-errors";
import { hexStringToBigInt, hexStringToBytes } from "@nomicfoundation/hardhat-utils/hex";
import { isObject } from "@nomicfoundation/hardhat-utils/lang";
import {
  rpcAddress,
  rpcAny,
  rpcData,
  validateParams,
} from "@nomicfoundation/hardhat-zod-utils/rpc";
import type { HookContext } from "hardhat/types/hooks";
import type { JsonRpcRequest, JsonRpcResponse } from "hardhat/types/providers";
import { Transaction } from "micro-eth-signer";

import type { KmsKeyConfig } from "../../types.ts";
import { keyIdentity } from "../config/key-identity.ts";
import { toChecksumAddress } from "../crypto/address.ts";
import { coreDebug } from "../debug.ts";
import { ERRORS } from "../error-catalog.ts";
import { catalogError, catalogMessage, errorName } from "../errors.ts";
import type { SignerCache } from "../signer/key-cache.ts";
import type { KmsSigner } from "../signer/kms-signer.ts";
import type { ConnectionChain } from "./chain-id.ts";
import {
  canonicalJson,
  type ConnectionSends,
  RETRY_TTL_MS,
  SendOutcomeUnknownError,
  type SentTransaction,
  describeSendKey,
  expectLibraryReset,
  holdForLibrary,
  holdsSendLock,
  libraryHoldOf,
  libraryHoldsActive,
  takeOwedLibraryReset,
  withSendLock,
} from "./send-guard.ts";
import { notPlainData, stringResult, type TransactionFiller } from "./transaction-filler.ts";
import { signTransaction } from "./transactions.ts";
import { checkTypedDataChain, readTypedData } from "./typed-data.ts";

const log = coreDebug("rpc");

/** The KMS keys of one network connection. */
export interface NetworkKeys {
  /** The network's name. */
  name: string;
  /** The network's `kmsAccounts`, in order. */
  config: readonly KmsKeyConfig[];
  /** The keys chosen with `--kms`, when this is the selected network. */
  commandLine: readonly KmsKeyConfig[];
}

/** The methods the dispatcher looks at; every other method passes through (rule 1). */
const ACCOUNT_METHODS = new Set(["eth_accounts", "eth_requestAccounts"]);
const TRANSACTION_METHODS = new Set(["eth_sendTransaction", "eth_signTransaction"]);
/**
 * The methods that broadcast a signed transaction: `eth_sendRawTransaction`, and its EIP-7966
 * form that waits for the receipt, which viem's `sendTransactionSync` and `writeContractSync` use.
 */
const RAW_SEND_METHODS = new Set(["eth_sendRawTransaction", "eth_sendRawTransactionSync"]);

/** The catalogue entries that refuse a wallet-namespace send. */
type WalletSendRefusal = typeof ERRORS.walletSendRefused | typeof ERRORS.walletSendCallsRefused;

/**
 * The wallet-namespace send methods, with the error that refuses each for a KMS sender. Both name
 * the sender in `from` of their first param, and the plugin signs neither: it answers them with
 * -32601 and never passes them to the node.
 *
 * - `wallet_sendTransaction`, the wallet-namespace form of `eth_sendTransaction`. viem sends it
 *   once after `eth_sendTransaction` fails with an error such as -32000, and uses it for every
 *   later send on the client if it gets a hash back. On -32601 viem throws the first error and
 *   keeps sending `eth_sendTransaction`, which the plugin signs.
 * - `wallet_sendCalls` (EIP-5792), which viem's `sendCalls` sends. With `experimental_fallback`,
 *   viem answers -32601 by sending each call with `eth_sendTransaction`, which the plugin signs.
 */
const WALLET_SEND_METHODS: ReadonlyMap<string, WalletSendRefusal> = new Map<
  string,
  WalletSendRefusal
>([
  ["wallet_sendTransaction", ERRORS.walletSendRefused],
  ["wallet_sendCalls", ERRORS.walletSendCallsRefused],
]);

/** JSON-RPC's "method not found" error code. */
const METHOD_NOT_FOUND = -32601;

/** The methods that name an account; a node or Hardhat refuses them for an account it lacks. */
const SENDER_METHODS = new Set([
  "eth_sendTransaction",
  "eth_signTransaction",
  "eth_sign",
  "personal_sign",
  "eth_signTypedData_v4",
]);

/** How many KMS addresses an "unknown account" error lists before it says "and N more". */
const LISTED_KMS_ADDRESSES = 10;

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
  #known: ReadonlyMap<string, KmsKeyConfig> | undefined;

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

  /** Whether the KMS addresses have been looked up, so {@link isKnownKmsAccount} can answer. */
  public get hasKnownAddresses(): boolean {
    return this.#known !== undefined;
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
   * Tells whether an address is a KMS account, from addresses already looked up. It never looks
   * them up, so it makes no KMS call and cannot fail.
   *
   * @param address - A lowercase address.
   * @returns Whether it is; `false` too while the addresses have not been looked up.
   */
  public isKnownKmsAccount(address: string): boolean {
    return this.#known?.has(address) ?? false;
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
        throw catalogError(
          ERRORS.sameAccount,
          { name: key.name, other: existing.name, address: toChecksumAddress(address) },
          { operation: "load accounts" },
        );
      }
      byAddress.set(normalized, key);
    }
    log("accounts: %s", [...byAddress.values()].map((key) => key.displayId).join(", "));
    this.#known = byAddress;
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
        throw catalogError(
          ERRORS.alreadyListed,
          { name: key.name, path, named },
          { provider: key.provider, operation: "load accounts" },
        );
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
  /** The connection's network name. */
  network: string;
  /** Whether the connection has closed: a send then broadcasts nothing. */
  closed(): boolean;
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
    // A library send from another connection's account may hold a lock that this raw transaction
    // must end. Without a hold, rawKmsTransaction finds nothing and the request passes on.
    const raw = RAW_SEND_METHODS.has(request.method)
      ? rawKmsTransaction(accounts, request.method, paramsOf(request))
      : undefined;
    return raw === undefined
      ? await next(request)
      : await sendRawTransaction(request, raw, transactions, next);
  }
  const params = paramsOf(request);
  if (ACCOUNT_METHODS.has(request.method)) {
    return response(request, await listAccounts(accounts, request, next));
  }
  if (request.method === "eth_sign") {
    const signed = await signFor(accounts, request.method, params[0], async (signer) => {
      const [, data] = validateParams(params, rpcAddress, rpcData);
      return await signer.signPersonalMessage(data);
    });
    if (signed !== undefined) {
      return response(request, signed.result);
    }
  } else if (request.method === "personal_sign") {
    const signed = await signFor(accounts, request.method, params[1], async (signer) => {
      const [data] = validateParams(params, rpcData, rpcAddress);
      return await signer.signPersonalMessage(data);
    });
    if (signed !== undefined) {
      return response(request, signed.result);
    }
  } else if (request.method === "eth_signTypedData_v4") {
    const signed = await signFor(accounts, request.method, params[0], async (signer) => {
      const data: unknown = validateParams(params, rpcAddress, rpcAny)[1];
      return await signTypedData(signer, data, policy);
    });
    if (signed !== undefined) {
      return response(request, signed.result);
    }
  } else if (TRANSACTION_METHODS.has(request.method)) {
    const outcome = await kmsTransactionOf(accounts, request.method, params, transactions);
    if (outcome !== undefined && "kms" in outcome && request.method === "eth_sendTransaction") {
      return await sendTransaction(accounts, request, outcome.kms, transactions, next);
    }
    if (outcome !== undefined && "kms" in outcome) {
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
    if (outcome !== undefined) {
      return await passThrough(accounts, { ...request, params: outcome.params }, next);
    }
  } else if (RAW_SEND_METHODS.has(request.method)) {
    const raw = rawKmsTransaction(accounts, request.method, params);
    if (raw !== undefined) {
      return await sendRawTransaction(request, raw, transactions, next);
    }
  } else {
    const refusal = WALLET_SEND_METHODS.get(request.method);
    if (refusal !== undefined) {
      const sender = await kmsWalletSender(accounts, params);
      if (sender !== undefined) {
        log("refused %s from KMS account %s", request.method, sender);
        const message = catalogMessage(refusal, { address: sender });
        return { jsonrpc: "2.0", id: request.id, error: { code: METHOD_NOT_FOUND, message } };
      }
    }
  }
  return await passThrough(accounts, request, next);
}

/**
 * The KMS account a wallet-namespace send names. Only a first param that is an object
 * whose `from` is a KMS address counts. A request without `from`, or with a `from` that is not an
 * address, passes on unchanged: Hardhat's sender handlers do not set `from` on either method, so no
 * handler after the plugin can add a KMS address. EIP-5792 makes `from` optional on
 * `wallet_sendCalls`; without it the wallet picks the account, and the plugin is not that wallet.
 *
 * @param accounts - The connection's KMS accounts.
 * @param params - The request's params.
 * @returns The checksummed address, or `undefined` when the sender is not a KMS account.
 */
async function kmsWalletSender(
  accounts: ConnectionAccounts,
  params: unknown[],
): Promise<string | undefined> {
  const [transaction] = params;
  const address = isObject(transaction) ? addressParam(transaction.from) : undefined;
  return address !== undefined && (await accounts.isKmsAccount(address))
    ? toChecksumAddress(address)
    : undefined;
}

/**
 * Passes a request on to the rest of the chain. When a request that names an account fails
 * because the node or Hardhat does not know that account, the error gets the KMS addresses
 * appended, so a mistyped address or a key missing from `kmsAccounts` shows. The error keeps its
 * class, code and data; any other answer or error comes back unchanged.
 */
async function passThrough(
  accounts: ConnectionAccounts,
  request: JsonRpcRequest,
  next: Next,
): Promise<JsonRpcResponse> {
  if (!SENDER_METHODS.has(request.method)) {
    return await next(request);
  }
  let answer: JsonRpcResponse;
  try {
    answer = await next(request);
  } catch (error) {
    if (error instanceof Error && isUnknownAccount(error)) {
      const sentence = kmsAccountsSentence(await kmsAddressesOf(accounts));
      if (sentence !== undefined) {
        appendInPlace(error, sentence);
      }
    }
    throw error;
  }
  if ("error" in answer && isUnknownAccount(answer.error)) {
    const sentence = kmsAccountsSentence(await kmsAddressesOf(accounts));
    if (sentence !== undefined) {
      const message = withSentence(answer.error.message, sentence);
      return { ...answer, error: { ...answer.error, message } };
    }
  }
  return answer;
}

/**
 * Tells whether an error says the account a request names is unknown:
 *
 * - Hardhat's `HardhatError` HHE716 (`NOT_LOCAL_ACCOUNT`), thrown by its local accounts on a
 *   network with `accounts` for an address that is not one of them: `Account "<address>" is not
 *   managed by the node you are connected to.`
 * - Code -32000 with a message that starts with "unknown account", in any case: Hardhat's
 *   simulated network (`Unknown account <address>`, thrown as a `ProviderError`) and Geth
 *   (`unknown account`, an error answer over http).
 * - Code -32602 with a message that is exactly `unknown account`, in any case (Reth), or exactly
 *   `No Signer available` (Anvil).
 *
 * @param error - A thrown error, or a JSON-RPC error answer.
 * @returns Whether it is.
 */
export function isUnknownAccount(error: unknown): boolean {
  if (HardhatError.isHardhatError(error, HardhatError.ERRORS.CORE.NETWORK.NOT_LOCAL_ACCOUNT)) {
    return true;
  }
  if (!isObject(error) || typeof error.message !== "string") {
    return false;
  }
  const { code, message } = error;
  if (code === -32000) {
    return /^\s*unknown account\b/i.test(message);
  }
  if (code === -32602) {
    return /^\s*unknown account\s*$/i.test(message) || message.trim() === "No Signer available";
  }
  return false;
}

/** Reads the KMS addresses; a failed read gives none, so the error stays as it is. */
async function kmsAddressesOf(accounts: ConnectionAccounts): Promise<string[]> {
  try {
    return await accounts.addresses();
  } catch (error) {
    log("listing the KMS accounts for an unknown account failed (%s)", errorName(error));
    return [];
  }
}

/**
 * The sentence an "unknown account" error gets: the KMS addresses, at most
 * {@link LISTED_KMS_ADDRESSES}, then "and N more". Only addresses, never key ids.
 *
 * @param addresses - The checksummed KMS addresses.
 * @returns The sentence, or `undefined` when there are no addresses.
 */
export function kmsAccountsSentence(addresses: readonly string[]): string | undefined {
  if (addresses.length === 0) {
    return undefined;
  }
  const shown = addresses.slice(0, LISTED_KMS_ADDRESSES).join(", ");
  const more = addresses.length - LISTED_KMS_ADDRESSES;
  const list = more > 0 ? `${shown} and ${more} more` : shown;
  return addresses.length === 1
    ? catalogMessage(ERRORS.kmsAccountSentence, { list })
    : catalogMessage(ERRORS.kmsAccountsSentence, { list });
}

/**
 * Appends a sentence to a message, after a full stop when the message has none. A message that
 * already holds the sentence, because the same error came through twice, is returned as it is.
 *
 * @param message - The error message.
 * @param sentence - From {@link kmsAccountsSentence}.
 * @returns The new message.
 */
export function withSentence(message: string, sentence: string): string {
  if (message.includes(sentence)) {
    return message;
  }
  const text = message.trimEnd();
  return `${text}${/[.!?]$/.test(text) ? "" : "."} ${sentence}`;
}

/**
 * Appends a sentence to a thrown error's `message`, the first line of its `stack`, and, for a
 * `HardhatError`, its `formattedMessage`, which Hardhat's CLI prints. The error object stays the
 * same, so its class, code and data stay. If any write fails, as on a frozen error, the writes
 * already made are undone and the error is left as it came.
 */
function appendInPlace(error: Error, sentence: string): void {
  const { message, stack } = error;
  const hardhat = HardhatError.isHardhatError(error) ? error : undefined;
  try {
    if (hardhat !== undefined) {
      Object.defineProperty(hardhat, "formattedMessage", {
        value: withSentence(hardhat.formattedMessage, sentence),
        configurable: true,
      });
    }
    error.message = withSentence(message, sentence);
    if (typeof stack === "string") {
      error.stack = stack.replace(message, () => error.message);
    }
  } catch (failure) {
    log("could not add the KMS accounts to the error (%s)", errorName(failure));
    // Undo both writes. Undoing one that never happened changes nothing: the message gets the
    // value it has, and a HardhatError's formattedMessage is a getter on its class, which a
    // delete of the own property leaves in place.
    Reflect.set(error, "message", message);
    if (hardhat !== undefined) {
      Reflect.deleteProperty(hardhat, "formattedMessage");
    }
  }
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
 * chain, either with the sender the plugin chose (`params`) or unchanged (`undefined`).
 */
type TransactionOutcome = { kms: KmsTransaction } | { params: unknown[] } | undefined;

/**
 * Finds the KMS account that signs a transaction, and copies the transaction.
 *
 * The transaction is copied before the first `await`, so a caller that changes its object
 * meanwhile cannot change what is signed. A transaction that cannot be copied is refused only
 * when its sender is a KMS account; any other request passes on as it came (rule 1).
 * A `from` that names a KMS account as 20 bytes rather than a hex string is refused too, before
 * any signature or read: Hardhat's simulated network and JSON-RPC nodes refuse that form, and
 * Hardhat's schema refuses the plain `Uint8Array` that the copy makes of a `Buffer`.
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
    return undefined;
  }
  const requestedFrom: unknown = original.from;
  let copy: { transaction: Record<string, unknown>; rest: unknown[] } | undefined;
  try {
    copy = structuredClone({ transaction: original, rest: originalRest });
  } catch {
    // Not plain data: copy stays undefined.
  }
  let from = requestedFrom;
  // Not for a KMS account: unchanged, or with the default sender set.
  let passOn: TransactionOutcome;
  if (from === undefined) {
    from = await transactions.defaultSender();
    if (from === undefined) {
      return undefined;
    }
    passOn = { params: [{ ...original, from }, ...originalRest] };
  }
  const address = addressParam(from);
  if (address === undefined) {
    return passOn;
  }
  if (typeof from !== "string" && (await accounts.isKmsAccount(address))) {
    // Otherwise the copy and the fill's reads carry the bytes to Hardhat's schema or the node.
    throw catalogError(
      ERRORS.txFromBytes,
      { address: toChecksumAddress(address) },
      { operation: method },
    );
  }
  if (copy === undefined) {
    if (await accounts.isKmsAccount(address)) {
      throw notPlainData(method);
    }
    return passOn;
  }
  const key = await accounts.keyFor(address);
  if (key === undefined) {
    return passOn;
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
  const retries =
    callerParams === undefined
      ? NO_RETRY
      : retrySlot(sends, `${chainId}\0${address}\0${callerParams}`);
  const nodeHas = async (hash: string): Promise<boolean> =>
    await nodeHasTransaction(transactions, hash);
  return await withSendLock(`${chainId}:${address}`, async () => {
    const retry = retries.take();
    // -1n when the sender has no mark yet, so no retry nonce is at or below it.
    const mark = sends.highWaterOf(address) ?? -1n;
    if (retry !== undefined && retry.nonce <= mark) {
      // A later send has used this nonce, or a higher one. The old bytes go out again only if the
      // node has them already; otherwise they could replace that later send, so sign afresh.
      if (await nodeHas(retry.hash)) {
        sends.settleUncertain(address, retry.hash);
        return response(request, retry.hash);
      }
      log("transaction %s is unknown and its nonce was used since; signing again", retry.hash);
    } else if (retry !== undefined) {
      log("sending transaction %s again for a retried request", retry.hash);
      return await broadcast(request, retry, {
        address,
        sends,
        retries,
        next,
        nodeHas,
        resend: true,
        callerNonce: kms.callerNonce,
        transactions,
      });
    }
    if (!kms.callerNonce) {
      await settleUncertain(address, sends, nodeHas);
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
    return await broadcast(request, signed, {
      address,
      sends,
      retries,
      next,
      nodeHas,
      resend: false,
      callerNonce: kms.callerNonce,
      transactions,
    });
  });
}

/**
 * Asks the node about the sender's last transaction whose broadcast got no answer. If the node
 * has it, the high-water mark rises to its nonce, so a node whose pending count lags cannot give
 * that nonce to the next send, which could replace the first transaction. If the node does not
 * have it, or the lookup fails, the mark stays and the node's pending count decides; the next
 * send may then take its nonce, so its retry entry is dropped and a retry of it signs afresh.
 */
async function settleUncertain(
  address: string,
  sends: ConnectionSends,
  nodeHas: (hash: string) => Promise<boolean>,
): Promise<void> {
  const uncertain = sends.takeUncertain(address);
  if (uncertain === undefined) {
    return;
  }
  if (await nodeHas(uncertain.hash)) {
    sends.recordSent(address, uncertain.nonce);
  } else {
    sends.dropRetriesOf(uncertain.hash);
  }
}

/**
 * Asks the node with `eth_getTransactionByHash` whether it has a transaction. A failed lookup
 * counts as no.
 */
async function nodeHasTransaction(
  transactions: ConnectionTransactions,
  hash: string,
): Promise<boolean> {
  let known = false;
  try {
    known = isObject(await transactions.request("eth_getTransactionByHash", [hash]));
  } catch (error) {
    log("looking up transaction %s failed (%s)", hash, errorName(error));
  }
  log("transaction %s is %s the node", hash, known ? "known to" : "not known to");
  return known;
}

/** The retry entry of one request: taken before its send, kept after a send without an answer. */
interface RetrySlot {
  /** Takes the request's retry entry, if one is alive. */
  take(): SentTransaction | undefined;
  /** Keeps a transaction for the request's next retry. */
  remember(transaction: SentTransaction): void;
}

/** The slot of a request whose params cannot be serialized for a retry key: it keeps nothing. */
const NO_RETRY: RetrySlot = {
  take: () => undefined,
  remember: () => {},
};

/**
 * The retry slot of a request in a connection's send state.
 *
 * @param sends - The connection's send state.
 * @param key - The retry key: chain id, sender and the caller's params.
 * @returns The slot.
 */
function retrySlot(sends: ConnectionSends, key: string): RetrySlot {
  return {
    take: () => sends.takeRetry(key),
    remember: (transaction) => {
      sends.rememberFailure(key, transaction);
    },
  };
}

/** What a broadcast needs besides the request and the transaction. */
interface BroadcastContext {
  address: string;
  sends: ConnectionSends;
  /** The request's retry entry. */
  retries: RetrySlot;
  next: Next;
  /** Asks the node whether it has a transaction. */
  nodeHas: (hash: string) => Promise<boolean>;
  /** Whether this sends a retry entry's bytes again. */
  resend: boolean;
  /** Whether the caller gave the nonce. */
  callerNonce: boolean;
  /** The connection, to check that it is still open before the broadcast. */
  transactions: ConnectionTransactions;
}

/**
 * Refuses a broadcast on a connection that has closed. Its send state is gone, so nothing would
 * record the nonce, and a send on another connection could take it. Hardhat's HTTP provider still
 * sends a request after `close()`, so the check cannot be left to it.
 */
function refuseIfClosed(transactions: ConnectionTransactions, method: string): void {
  if (transactions.closed()) {
    throw catalogError(ERRORS.sendConnectionClosed, { method, network: transactions.network });
  }
}

/**
 * Tells whether a node refused a raw transaction because it already has it. The message must
 * start with what a client says: "already known" (Geth, Reth, Erigon), "AlreadyKnown"
 * (Nethermind) or "known transaction" (older Geth, and Hardhat's EDR as "Known transaction:
 * <hash>"). A message such as "unknown transaction type" does not match, and neither does one that
 * is not a string, which only a broken node sends.
 */
export function isAlreadyKnown(message: unknown): boolean {
  return (
    typeof message === "string" &&
    /^\s*(?:already known\b|alreadyknown\b|known transaction\b)/i.test(message)
  );
}

/**
 * Tells whether a thrown error is an answer from the node. Hardhat's errors for node answers
 * carry a numeric `code` other than -1: `ProviderError` and its subclasses (including
 * `LimitExceededError`, -32005, after repeated HTTP 429s), and `SolidityError` (code 3) for a
 * reverted transaction. Hardhat's `UnknownError` has code -1 and wraps a failed HTTP request (a
 * 4xx or 5xx status, or a transport error), and its `HardhatError`s for a refused connection or a
 * timeout have no `code`; none of them is an answer.
 *
 * @returns The error as a record when it is an answer, else `undefined`.
 */
function nodeAnswer(error: unknown): Record<string, unknown> | undefined {
  return isObject(error) && typeof error.code === "number" && error.code !== -1 ? error : undefined;
}

/**
 * Tells whether a thrown error is Hardhat's refused connection (HHE703), which means the request
 * never reached the node.
 */
function isConnectionRefused(error: unknown): boolean {
  return HardhatError.isHardhatError(error, HardhatError.ERRORS.CORE.NETWORK.CONNECTION_REFUSED);
}

/**
 * Tells whether an error answer says the node does not know what happened: an internal error
 * (-32603), as gateways answer when the backend they forwarded to timed out, or a message that
 * says the request timed out ("timeout", "timed out", "deadline exceeded"). The backend may have
 * taken the transaction before it gave up. A message that starts with "execution reverted" or
 * "revert" is a revert, whatever its code or reason. The code and the message are the answer's as
 * they came, which only a broken node sends as other types than a number and a string.
 */
export function isUncertainAnswer(code: unknown, message: unknown): boolean {
  // A revert's reason can say anything, "Deadline exceeded" included; it is a definite answer.
  if (typeof message === "string" && /^\s*(?:execution reverted|revert)/i.test(message)) {
    return false;
  }
  return (
    code === -32603 ||
    (typeof message === "string" && /\btimed? ?out\b|deadline exceeded/i.test(message))
  );
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
 * Sends a signed transaction with exactly one `next(eth_sendRawTransaction)`, and sorts the
 * outcome (docs/contributor/transactions.md, "Retries after broadcast"):
 *
 * - The connection has closed: nothing is sent, and `core.tx.connection-closed` is thrown.
 * - The node accepts it: its answer is returned as it is.
 * - Hardhat cannot connect (HHE703): nothing was sent, and Hardhat's error is rethrown as it is.
 * - The node answers with an error, returned or thrown with a JSON-RPC code: the answer is
 *   returned, or the error rethrown, as it is.
 *   - It says the transaction was mined anyway: its nonce counts as used.
 *   - Bytes were sent again and it says "already known": success.
 *   - It is a gateway's "I don't know" ({@link isUncertainAnswer}): the outcome is unknown, and
 *     the transaction is kept for one retry and for a lookup before the sender's next send.
 *   - Bytes were sent again and it refuses them: the node is asked whether it has the
 *     transaction, and if so the send counts as a success.
 *   - Otherwise it is a refusal, and nothing is kept.
 * - No answer (a thrown error that is not an answer, such as a timeout or an HTTP error status):
 *   the transaction is kept as above, and a {@link SendOutcomeUnknownError} is thrown.
 */
async function broadcast(
  request: JsonRpcRequest,
  transaction: SentTransaction,
  context: BroadcastContext,
): Promise<JsonRpcResponse> {
  const { address, sends, retries, next, nodeHas, resend } = context;
  refuseIfClosed(context.transactions, request.method);
  // The node has the transaction: its nonce is used. Only a nonce the caller chose ends the
  // reservations up to it; a nonce the plugin chose skipped them, and their sends still run.
  const nodeHasIt = (): void => {
    sends.settleUncertain(address, transaction.hash);
    sends.recordSent(address, transaction.nonce);
    if (context.callerNonce) {
      sends.releaseReservationsUpTo(address, transaction.nonce);
    }
  };
  const accepted = (): JsonRpcResponse => {
    nodeHasIt();
    return response(request, transaction.hash);
  };
  const keepUncertain = (): void => {
    retries.remember(transaction);
    sends.rememberUncertain(address, transaction);
  };
  let error: Record<string, unknown>;
  let passOn: () => JsonRpcResponse;
  try {
    const answer = await next({
      ...request,
      method: "eth_sendRawTransaction",
      params: [transaction.raw],
    });
    if (!("error" in answer)) {
      nodeHasIt();
      return answer;
    }
    error = answer.error;
    passOn = () => answer;
  } catch (thrown) {
    if (isConnectionRefused(thrown)) {
      log("sending transaction %s: the node refused the connection", transaction.hash);
      if (resend) {
        // The first send's outcome is still unknown: keep its bytes for the next retry.
        retries.remember(transaction);
      }
      throw thrown;
    }
    const answer = nodeAnswer(thrown);
    if (answer === undefined) {
      keepUncertain();
      // Only the class name: a transport error's text can include the node's URL.
      const cause = errorName(thrown);
      log("sending transaction %s got no answer (%s)", transaction.hash, cause);
      throw new SendOutcomeUnknownError(
        catalogMessage(ERRORS.sendOutcomeUnknown, {
          method: request.method,
          hash: transaction.hash,
          cause,
          seconds: RETRY_TTL_MS / 1000,
        }),
        transaction.hash,
      );
    }
    error = answer;
    passOn = () => {
      throw thrown;
    };
  }
  const { code, message } = error;
  if (minedHashOf(error) !== undefined || code === 3) {
    // Mined, or reverted when it ran: a definite answer.
    if (minedHashOf(error) !== undefined) {
      nodeHasIt();
      return passOn();
    }
    // A revert without a hash, for bytes sent again: the first send may have been mined, and
    // the node now refuses its nonce with a simulated revert.
    if (resend && (await nodeHas(transaction.hash))) {
      return accepted();
    }
    sends.settleUncertain(address, transaction.hash);
    return passOn();
  }
  if (resend && isAlreadyKnown(message)) {
    return accepted();
  }
  if (isUncertainAnswer(code, message)) {
    // The code as the node sent it; only a number is printed, so formatting cannot throw.
    log(
      "sending transaction %s: the node does not know the outcome (%s)",
      transaction.hash,
      typeof code === "number" ? code : typeof code,
    );
    keepUncertain();
    return passOn();
  }
  if (resend && (await nodeHas(transaction.hash))) {
    // Refused now, because the first send of these bytes went through.
    return accepted();
  }
  sends.settleUncertain(address, transaction.hash);
  return passOn();
}

/**
 * A raw transaction whose sender is one of the connection's KMS accounts, or may be the account
 * of a library send that holds a lock.
 */
interface RawKmsTransaction {
  /** The sender's lowercase address. */
  address: string;
  /** The raw transaction, its hash and its nonce. */
  transaction: SentTransaction;
  /**
   * The chain it was signed for; `undefined` for a legacy transaction without EIP-155 replay
   * protection, which is valid on every chain.
   */
  chainId: bigint | undefined;
  /**
   * Whether the sender is not one of the connection's known KMS accounts (the addresses have not
   * been looked up, or the connection has other keys or none), so it counts only when a library
   * send of that address holds the lock on this chain.
   */
  heldOnly: boolean;
}

/**
 * Finds the KMS account that signed the raw transaction of an `eth_sendRawTransaction` or
 * `eth_sendRawTransactionSync` request. The sender is recovered when the connection's KMS
 * addresses have already been looked up, as `connection.kms.getAccount`, a send or `eth_accounts`
 * does, or when a library send holds a lock, which its raw transaction must end even when it
 * reaches a connection that has not looked them up, has other KMS keys or has none. So a raw
 * transaction never causes a KMS call.
 * Params that do not decode as a signed transaction give `undefined`, and the request passes on
 * unchanged.
 *
 * @param accounts - The connection's KMS accounts.
 * @param method - The request's method, for the debug output.
 * @param params - The request's params.
 * @returns The transaction, or `undefined` when it is not a KMS account's and no library send
 * holds a lock.
 */
function rawKmsTransaction(
  accounts: ConnectionAccounts,
  method: string,
  params: readonly unknown[],
): RawKmsTransaction | undefined {
  const [raw] = params;
  const held = libraryHoldsActive();
  if (typeof raw !== "string" || (!accounts.hasKnownAddresses && !held)) {
    return undefined;
  }
  let address: string;
  let nonce: bigint;
  let chainId: bigint | undefined;
  try {
    // Strict mode off, as the plugin decodes its own transactions: a node is the judge of the rest.
    const transaction = Transaction.fromHex(raw, false);
    address = transaction.sender.toLowerCase();
    nonce = transaction.raw.nonce;
    chainId = transaction.raw.chainId;
  } catch (error) {
    log("%s: the plugin cannot decode it (%s); passed on", method, errorName(error));
    return undefined;
  }
  // False while the addresses have not been looked up.
  const heldOnly = !accounts.isKnownKmsAccount(address);
  if (heldOnly && !held) {
    return undefined;
  }
  const hash = `0x${Buffer.from(keccak_256(hexStringToBytes(raw))).toString("hex")}`;
  return { address, transaction: { raw, hash, nonce }, chainId, heldOnly };
}

/**
 * Broadcasts a KMS account's raw transaction, signed outside the plugin (by a
 * `connection.kms.getAccount` account, for example), under the same send lock as the account's
 * `eth_sendTransaction` requests. The request goes on unchanged, with exactly one `next`, and its
 * answer or error comes back unchanged. Only the connection's send state learns from it: when the
 * node has the transaction, its nonce raises the high-water mark and its nonce reservation ends,
 * so the account's next send through the plugin takes a higher nonce; when the outcome is unknown,
 * the transaction becomes the account's uncertain transaction, which that next send looks up
 * first.
 *
 * The raw transaction of a library send that holds the account's lock (same chain, sender and
 * nonce) ends the hold, and its outcome is also recorded on the connection that gave the hold,
 * when it came through another one.
 *
 * A raw transaction made from inside a send from the same account, which would wait for itself,
 * fails at once and is not sent. When the chain id cannot be read, or the transaction was signed
 * for another chain, the request passes on unchanged.
 */
async function sendRawTransaction(
  request: JsonRpcRequest,
  raw: RawKmsTransaction,
  transactions: ConnectionTransactions,
  next: Next,
): Promise<JsonRpcResponse> {
  let chainId: bigint;
  try {
    chainId = await transactions.chainId();
  } catch (error) {
    log("%s: the chain id is unknown (%s); passed on", request.method, errorName(error));
    return await next(request);
  }
  if (raw.chainId !== undefined && raw.chainId !== chainId) {
    log("%s: signed for chain %d, not this connection's; passed on", request.method, raw.chainId);
    return await next(request);
  }
  const key = `${chainId}:${raw.address}`;
  const hold = libraryHoldOf(key);
  if (raw.heldOnly && hold === undefined) {
    return await next(request);
  }
  if (holdsSendLock(key)) {
    throw catalogError(ERRORS.rawSendReentrant, { account: describeSendKey(key) });
  }
  const sends = transactions.sends();
  // A library account signs only EIP-155 transactions, so one without a chain id is never the
  // holder's: it takes the lock as any other raw transaction does.
  if (hold?.nonce === raw.transaction.nonce && raw.chainId !== undefined) {
    // The library send that holds the lock for this nonce: it goes out as the holder.
    let failed = true;
    try {
      // The hold's owner learns the outcome too: its next send must count this nonce.
      const answer = await broadcastRaw(request, raw, [sends, hold.owner], next, transactions);
      failed = "error" in answer;
      return answer;
    } finally {
      // viem resets the nonce manager after an error; that reset must not end another hold.
      if (failed) {
        expectLibraryReset(key, hold.owner);
      }
      // This hold only: after its time limit, another send may hold the lock by now.
      hold.end();
    }
  }
  return await underSendLock(
    key,
    request,
    next,
    async () => await broadcastRaw(request, raw, [sends], next, transactions),
  );
}

/** How a library account's nonce manager asks for a nonce. */
export interface LibraryNonceRequest {
  /** The account's lowercase address. */
  address: string;
  /** The chain viem asks for. */
  chainId: bigint;
  /** `consume`: the send will use the nonce. `get`: only read it. */
  reserve: boolean;
  /** Whether the client's transport does not go through Hardhat, such as `http(url)`. */
  ownTransport: boolean;
  /** The account's signal: when it aborts, a `consume` waiting for the send lock stops waiting. */
  signal?: AbortSignal | undefined;
}

/**
 * Chooses the nonce of a library account's transaction, for its viem `nonceManager`: the node's
 * pending count, read through the connection and passed on unchanged, raised past the high-water
 * mark and past reserved nonces (`ConnectionSends.nonceFor`), the nonce a send through the plugin
 * would take.
 *
 * For `consume`, the choice runs under the account's send lock, so a send through the plugin in
 * progress is broadcast first. With a client that sends through the connection, the send then
 * keeps the lock until its raw transaction is broadcast or viem resets it (`holdForLibrary`), as
 * a send through the plugin keeps it from its fill to its broadcast: the account's other sends
 * wait, and the next one counts this one. A client with its own transport never sends through
 * the connection, so the lock is released at once and the nonce is reserved instead: sends
 * through the plugin skip it until viem resets it or {@link RESERVATION_MS} pass.
 *
 * For another chain than the connection's, it returns the pending count and holds nothing; the
 * account's `signTransaction` then refuses the transaction. Called from inside a send from the
 * same account, which would wait for itself, it fails at once.
 *
 * @param transactions - The connection's send state and requests.
 * @param request - The account, the chain and the kind of request.
 * @returns The nonce.
 */
export async function libraryNonce(
  transactions: ConnectionTransactions,
  request: LibraryNonceRequest,
): Promise<bigint> {
  const { address, chainId, reserve } = request;
  const operation = reserve ? "nonceManager.consume" : "nonceManager.get";
  const pending = async (): Promise<bigint> =>
    hexStringToBigInt(
      stringResult(
        await transactions.request("eth_getTransactionCount", [address, "pending"]),
        "eth_getTransactionCount",
        operation,
      ),
    );
  if (chainId !== (await transactions.chainId())) {
    return await pending();
  }
  const sends = transactions.sends();
  const choose = async (): Promise<bigint> => sends.nonceFor(address, await pending());
  if (!reserve) {
    return await choose();
  }
  // Under the lock, as a send through the plugin does: a transaction whose broadcast got no
  // answer is looked up first, so a node whose pending count lags cannot hand out its nonce.
  const requireOpen = (): void => {
    if (transactions.closed()) {
      throw catalogError(
        ERRORS.accountConnectionClosed,
        { network: transactions.network },
        { operation },
      );
    }
  };
  const chooseForSend = async (): Promise<bigint> => {
    // A consume that waited for the lock while its connection closed holds and reserves nothing.
    requireOpen();
    await settleUncertain(
      address,
      sends,
      async (hash) => await nodeHasTransaction(transactions, hash),
    );
    return await choose();
  };
  const key = `${chainId}:${address}`;
  // A failure holds and reserves nothing. viem's reset after it stays in the account's nonce
  // manager, which counts its failed consumes, so it cannot end another send's hold.
  if (holdsSendLock(key)) {
    throw catalogError(
      ERRORS.accountNonceReentrant,
      { account: describeSendKey(key) },
      { operation },
    );
  }
  if (!request.ownTransport) {
    const nonce = await holdForLibrary(
      key,
      sends,
      chooseForSend,
      undefined,
      request.signal,
      requireOpen,
    );
    log("%s: nonce %d given to a library account's send, which holds the lock", address, nonce);
    return nonce;
  }
  return await withSendLock(
    key,
    async () => {
      const nonce = await chooseForSend();
      requireOpen();
      sends.reserve(address, nonce);
      log("%s: nonce %d reserved for a library account's own transport", address, nonce);
      return nonce;
    },
    undefined,
    request.signal,
  );
}

/**
 * Handles viem's `reset` for a library account's send that failed: it ends the send's hold of the
 * lock, or, for a client with its own transport, one reservation. A reset for another chain than
 * the connection's comes from a send that got no nonce from the plugin, and does nothing. A reset
 * after a failed `consume` never gets here: the account's nonce manager keeps it.
 *
 * viem passes `reset` only the address and the chain, not the client or the nonce, so a reset
 * cannot say which `consume` it follows. It only ever ends a hold that this connection gave. In
 * order:
 *
 * 1. A reset owed by a send whose broadcast failed, which holds nothing any more, is used up.
 * 2. With a live reservation of the sender on this connection, the reservations take the reset
 *    (`ConnectionSends.resetReservation`), and a hold stays. A reservation's send started before
 *    the hold took the lock, so it may well fail while the hold lasts, and so may one whose nonce
 *    the node already has: viem resets after a timeout too. Ending the hold instead would let a
 *    send through the plugin take the held nonce before its raw transaction goes out. The cost of
 *    a wrong guess is the other way round: a held send that failed keeps the lock until its 60 s
 *    limit, or until the reservation's own reset comes.
 * 3. Otherwise the reset is the hold's, if this connection gave it.
 *
 * @param transactions - The connection's send state.
 * @param address - The account's lowercase address.
 * @param chainId - The chain viem names.
 */
export async function resetLibraryNonce(
  transactions: ConnectionTransactions,
  address: string,
  chainId: bigint,
): Promise<void> {
  if (chainId !== (await transactions.chainId())) {
    return;
  }
  const key = `${chainId}:${address}`;
  const sends = transactions.sends();
  if (takeOwedLibraryReset(key, sends)) {
    return;
  }
  // Only a hold this connection gave: a reset through another connection, or through this one
  // after it closed, is never this hold's.
  if (sends.hasReservations(address)) {
    sends.resetReservation(key);
    return;
  }
  // Only a hold this connection gave: a reset through another connection, or through this one
  // after it closed, is never this hold's.
  const hold = libraryHoldOf(key);
  if (hold?.owner === sends) {
    hold.end();
  }
}

/**
 * Runs a raw transaction under the send lock. When the lock cannot be had (too many waiters, or
 * 120 s without progress), the request passes on unchanged instead: the transaction was signed
 * outside the plugin, and waiting for the plugin's sends must not make it fail. An error from
 * `run` itself comes back as it is.
 */
async function underSendLock(
  key: string,
  request: JsonRpcRequest,
  next: Next,
  run: () => Promise<JsonRpcResponse>,
): Promise<JsonRpcResponse> {
  let started = false;
  try {
    return await withSendLock(key, async () => {
      started = true;
      return await run();
    });
  } catch (error) {
    if (started) {
      throw error;
    }
    log("%s: the send lock could not be had (%s); passed on", request.method, errorName(error));
    return await next(request);
  }
}

/**
 * The error code of an `eth_sendRawTransactionSync` answer (EIP-7966) that says the transaction
 * is in the node's pool but no receipt came within the timeout.
 */
const SYNC_TIMEOUT_CODE = 4;

/**
 * Sends a raw transaction on with one `next`, and records what the answer says about its nonce.
 * Accepted (a hash, or the receipt of `eth_sendRawTransactionSync`), mined with an error, "already
 * known", or EIP-7966's timeout (code 4: in the pool, no receipt yet) means the node has it: the
 * mark rises and the nonce's reservation ends. Any other outcome marks the reservation failed, so the client's
 * `reset` after its error ends that one; an uncertain answer or no answer also makes it the
 * uncertain transaction. Unlike {@link broadcast}, nothing is wrapped or kept for a retry: the
 * caller holds the bytes and can send them again. On a closed connection nothing is sent, and
 * `core.tx.connection-closed` is thrown. Every send state in `learners` records the
 * outcome; recording it twice in one changes nothing.
 */
async function broadcastRaw(
  request: JsonRpcRequest,
  raw: RawKmsTransaction,
  learners: readonly ConnectionSends[],
  next: Next,
  transactions: ConnectionTransactions,
): Promise<JsonRpcResponse> {
  refuseIfClosed(transactions, request.method);
  const { address, transaction } = raw;
  const nodeHasIt = (): void => {
    for (const sends of learners) {
      sends.settleUncertain(address, transaction.hash);
      sends.recordSent(address, transaction.nonce);
      sends.releaseReservation(address, transaction.nonce);
    }
  };
  const failReservation = (): void => {
    for (const sends of learners) {
      sends.failReservation(address, transaction.nonce);
    }
  };
  const rememberUncertain = (): void => {
    for (const sends of learners) {
      sends.rememberUncertain(address, transaction);
    }
  };
  const learn = (error: Record<string, unknown>): void => {
    const { code, message } = error;
    if (
      minedHashOf(error) !== undefined ||
      isAlreadyKnown(message) ||
      (request.method === "eth_sendRawTransactionSync" && code === SYNC_TIMEOUT_CODE)
    ) {
      nodeHasIt();
      return;
    }
    failReservation();
    if (isUncertainAnswer(code, message)) {
      rememberUncertain();
    }
  };
  let answer: JsonRpcResponse;
  try {
    answer = await next(request);
  } catch (thrown) {
    const error = nodeAnswer(thrown);
    if (error !== undefined) {
      learn(error);
    } else {
      failReservation();
      if (!isConnectionRefused(thrown)) {
        log("raw transaction %s got no answer (%s)", transaction.hash, errorName(thrown));
        rememberUncertain();
      }
    }
    throw thrown;
  }
  if ("error" in answer) {
    learn(answer.error);
  } else {
    nodeHasIt();
  }
  return answer;
}

/**
 * Signs with the KMS account named by an address param. A KMS account named as 20 bytes rather
 * than a hex string is refused before any signature: Hardhat's simulated network and JSON-RPC
 * nodes refuse that form, and Hardhat's schema refuses a plain `Uint8Array`.
 *
 * @returns The result, or `undefined` when the param is not a KMS account's address.
 */
async function signFor<T>(
  accounts: ConnectionAccounts,
  method: string,
  value: unknown,
  sign: (signer: KmsSigner) => Promise<T>,
): Promise<{ result: T } | undefined> {
  const address = addressParam(value);
  if (address === undefined) {
    return undefined;
  }
  if (typeof value !== "string" && (await accounts.isKmsAccount(address))) {
    throw catalogError(
      ERRORS.addressBytes,
      { address: toChecksumAddress(address) },
      { operation: method },
    );
  }
  return await accounts.withSigner(address, sign);
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
  const operation = "eth_signTypedData_v4";
  const typedData = readTypedData(data, operation);
  await checkTypedDataChain(typedData, {
    operation,
    allowCrossChain: policy.allowCrossChainTypedData,
    expectedChain: async () => ({ chainId: await policy.chain.chainId(), name: "this network" }),
    mismatch: ERRORS.typedDataChainMismatchNetwork,
  });
  return await signer.signTypedData(typedData);
}
