// A port of the transaction filling that Hardhat's built-in request handlers do before its
// local-accounts handler signs (decision 0002). Pinned to Hardhat 3.18.0; the fill steps are
// unchanged through 3.21.0:
// dist/src/internal/builtin-plugins/network-manager/request-handlers/, files
// handlers-array.js, handlers/gas/{automatic-gas-price,fixed-gas-price,automatic-gas,fixed-gas,
// multiplied-gas-estimation}-handler.js and handlers/accounts/local-accounts.js
// (#modifyRequest and #getSignedTransaction). The differential test in
// test/integration/transaction-filler.test.ts fails when the two drift apart. The deliberate
// differences are listed in docs/contributor/transactions.md; one is that gas is estimated at the
// pending block (#492).
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { HardhatError } from "@nomicfoundation/hardhat-errors";
import { min } from "@nomicfoundation/hardhat-utils/bigint";
import {
  bytesToHexString,
  hexStringToBigInt,
  hexStringToNumber,
  isHexString,
  numberToHexString,
} from "@nomicfoundation/hardhat-utils/hex";
import { isObject } from "@nomicfoundation/hardhat-utils/lang";
import { bytesToBigInt, bytesToNumber } from "@nomicfoundation/hardhat-utils/number";
import {
  type RpcTransactionRequest,
  rpcTransactionRequest,
  validateParams,
} from "@nomicfoundation/hardhat-zod-utils/rpc";
import type { HardhatPluginError } from "hardhat/plugins";
import type { NetworkConnection } from "hardhat/types/network";
import { addr, Transaction } from "micro-eth-signer";

import { ERRORS } from "../error-catalog.ts";
import { catalogError } from "../errors.ts";
import type { ConnectionChain } from "./chain-id.ts";

/** Sends one JSON-RPC request on the connection, through the whole hook chain. */
export type RequestFunction = (method: string, params?: unknown[]) => Promise<unknown>;

/** The network settings that decide how a transaction is filled. */
export interface FillSettings {
  /** The network's `gas`: estimate it, or a fixed gas limit. */
  gas: "auto" | bigint;
  /** The network's `gasPrice`: suggest fees, or a fixed legacy gas price. */
  gasPrice: "auto" | bigint;
  /** The network's `gasMultiplier`, applied to gas estimates. */
  gasMultiplier: number;
  /** The gas limit to use when an internal call runs out of gas during estimation, if known. */
  fallbackGas: bigint | undefined;
  /** Whether the network rejects transactions above the block gas limit. */
  isBlockGasLimitEnforced: () => boolean;
}

/** A transaction with every field its signature needs: gas, fees, nonce and chain id. */
export type FilledTransaction = RpcTransactionRequest & {
  gas: bigint;
  nonce: bigint;
  chainId: bigint;
};

/** A micro-eth-signer transaction. The filler builds legacy, EIP-2930, EIP-1559 and EIP-7702 ones. */
export type UnsignedTransaction = ReturnType<typeof Transaction.fromHex>;

/** EIP-1559 fees suggested from the node's `eth_feeHistory`. */
interface Eip1559Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Fills a KMS account's transaction the way Hardhat fills a local account's. */
export interface TransactionFiller {
  /**
   * Fills a transaction request.
   *
   * @param method - `eth_sendTransaction` or `eth_signTransaction`, for error messages.
   * @param params - The request's params; the first is the transaction, with `from` set.
   * @returns The filled transaction.
   */
  fill(method: string, params: readonly unknown[]): Promise<FilledTransaction>;
}

// AutomaticGasPriceHandler: pay the base fee that 3 full blocks in a row can reach (each full
// block raises it by 1/8), and ask eth_feeHistory for the median priority fee.
const BASE_FEE_FULL_BLOCKS = 3n;
const REWARD_PERCENTILE = 50;
// The JSON-RPC error code of a method the node does not have.
const METHOD_NOT_FOUND = -32601;
// The JSON-RPC error code of params the node does not accept.
const INVALID_PARAMS = -32602;
// The JSON-RPC error code of a reverted call (geth, Erigon, reth, Nethermind).
const EXECUTION_REVERTED = 3;
// geth's answer when it has no pending block (eth/api_backend.go, -32000).
const PENDING_UNAVAILABLE = /pending (?:state|block) is not available/i;
// A revert or another execution failure, which is never a refusal of the tag.
const REVERT = /revert/i;
const EXECUTION = /execution/i;
// Another node's refusal: a message that names `pending` together with one of these words.
const PENDING = /pending/i;
const REFUSAL = /tag|block|support|not available/i;
// MultipliedGasEstimation: the share of the latest block's gas limit that is cached as the cap.
const BLOCK_GAS_LIMIT_SAFETY_FACTOR = 0.95;

/**
 * Tells whether an error is Hardhat's `InternalCallOutOfGasError`: EDR's estimation failure when
 * an internal call runs out of gas whatever the gas limit. Hardhat checks it with `instanceof`,
 * but does not export the class, so this checks its JSON-RPC code (-32000) together with its
 * class name or the `reason` Hardhat puts in its data. Either is enough, so a rename on one side
 * does not break the check.
 */
function isInternalCallOutOfGas(error: Error): boolean {
  if (Reflect.get(error, "code") !== -32000) {
    return false;
  }
  const data: unknown = Reflect.get(error, "data");
  return (
    error.name === "InternalCallOutOfGasError" ||
    (isObject(data) && data.reason === "InternalCallOutOfGas")
  );
}

/**
 * Tells whether a failed `eth_estimateGas` at the `pending` block is the node refusing the block
 * tag. Never for an error with code 3 or a message that says revert. Otherwise a known refusal
 * (JSON-RPC code -32602, or geth's "pending state is not available" or "pending block is not
 * available"), or a message that does not mention execution and names `pending` together with
 * "tag", "block", "support" or "not available", as other nodes word it. A timeout or anything else
 * is not a refusal.
 */
function refusesPendingTag(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code: unknown = Reflect.get(error, "code");
  const { message } = error;
  if (code === EXECUTION_REVERTED || REVERT.test(message)) {
    return false;
  }
  if (code === INVALID_PARAMS || PENDING_UNAVAILABLE.test(message)) {
    return true;
  }
  return !EXECUTION.test(message) && PENDING.test(message) && REFUSAL.test(message);
}

/**
 * Fills transactions for one network connection. It keeps what Hardhat's handlers keep per
 * connection: whether the node supports EIP-1559 and `eth_feeHistory`, and the capped block gas
 * limit. Unlike Hardhat, it remembers only a node's "method not found" for `eth_feeHistory`: see
 * #suggestEip1559Fees.
 */
export class HardhatTransactionFiller implements TransactionFiller {
  readonly #request: RequestFunction;
  readonly #chainId: () => Promise<bigint>;
  readonly #settings: FillSettings;
  #nodeSupportsEip1559: boolean | undefined;
  #nodeHasFeeHistory: boolean | undefined;
  #blockGasLimit: number | undefined;

  /**
   * @param request - Sends requests on the connection.
   * @param chainId - The connection's chain id.
   * @param settings - The network's fill settings.
   */
  public constructor(
    request: RequestFunction,
    chainId: () => Promise<bigint>,
    settings: FillSettings,
  ) {
    this.#request = request;
    this.#chainId = chainId;
    this.#settings = settings;
  }

  /**
   * Fills a transaction in Hardhat's order: fees, gas, then the local-accounts checks, the chain
   * id and the nonce. The caller's objects are not changed.
   *
   * @param method - `eth_sendTransaction` or `eth_signTransaction`, for error messages.
   * @param params - The request's params; the first is the transaction, with `from` set.
   * @returns The filled transaction.
   */
  public async fill(method: string, params: readonly unknown[]): Promise<FilledTransaction> {
    const [first, ...rest] = copyParams(params, method);
    if (!isObject(first)) {
      throw catalogError(ERRORS.txNotObject, {}, { operation: method });
    }
    if (
      first.blobs !== undefined ||
      first.blobVersionedHashes !== undefined ||
      first.maxFeePerBlobGas !== undefined ||
      isBlobType(first.type)
    ) {
      throw catalogError(ERRORS.txBlob, {}, { operation: method });
    }
    // A deep copy: the caller's objects, including access and authorization lists, stay as they are.
    const tx: Record<string, unknown> = first;
    applyRequestedType(tx, method, this.#settings.gasPrice === "auto");
    canonicalAuthorizationSignatures(tx, method);
    // Hardhat estimates gas with the request's params, after the fees are filled in.
    const filledParams = [tx, ...rest];
    if (this.#settings.gasPrice === "auto") {
      await this.#fillFees(tx, method);
    } else if (
      tx.gasPrice === undefined &&
      tx.maxFeePerGas === undefined &&
      tx.maxPriorityFeePerGas === undefined
    ) {
      tx.gasPrice = numberToHexString(this.#settings.gasPrice);
    }
    if (tx.gas === undefined) {
      tx.gas =
        this.#settings.gas === "auto"
          ? await this.#estimateGas(filledParams, await this.#estimateTag(tx, method))
          : numberToHexString(this.#settings.gas);
    }
    // applyRequestedType has read `type`, in any numeric form, and the fields decide the type, so
    // the schema does not see it. From hardhat-zod-utils 3.0.7 the schema reads `type` and refuses
    // a number or a quantity with leading zeros, which this filler accepts.
    const { type: _type, ...untyped } = tx;
    // The node got r and s as quantities; Hardhat's schema wants them as 32 bytes.
    const [request] = validateParams(
      [withPaddedAuthorizationSignatures(untyped), ...rest],
      rpcTransactionRequest,
    );
    const gas = requireGas(request, method);
    checkFeeFields(request, method);
    const chainId = await this.#checkChain(request.chainId, method);
    const nonce = request.nonce ?? (await this.#pendingNonce(request.from, method));
    return { ...request, gas, nonce, chainId };
  }

  /** The connection's chain id; a transaction's own `chainId` must be the same. */
  async #checkChain(requested: bigint | undefined, method: string): Promise<bigint> {
    const chainId = await this.#chainId();
    if (requested !== undefined && requested !== chainId) {
      throw catalogError(ERRORS.txWrongChain, { requested, chainId }, { operation: method });
    }
    return chainId;
  }

  async #pendingNonce(from: Uint8Array, method: string): Promise<bigint> {
    return await this.#pendingCount(bytesToHexString(from), method);
  }

  async #pendingCount(from: unknown, method: string): Promise<bigint> {
    const count = await this.#request("eth_getTransactionCount", [from, "pending"]);
    return hexStringToBigInt(stringResult(count, "eth_getTransactionCount", method));
  }

  /**
   * The block tag to estimate at. A transaction without a nonce takes the pending count, so it is
   * estimated at `pending`, the state that count describes (#492). So is one whose nonce is at or
   * above the pending count. A caller's nonce below it replaces a pending transaction: the pending
   * state already holds the one it replaces, whose effects (such as the account nonce a
   * self-sponsored EIP-7702 authorization is checked against) the replacement must not see, so it
   * is estimated without a tag, as Hardhat does.
   */
  async #estimateTag(tx: Record<string, unknown>, method: string): Promise<"pending" | undefined> {
    const nonce = quantityOf(tx.nonce);
    if (nonce === undefined) {
      return "pending";
    }
    return nonce < (await this.#pendingCount(tx.from, method)) ? undefined : "pending";
  }

  /** AutomaticGasPriceHandler#handle. */
  async #fillFees(tx: Record<string, unknown>, method: string): Promise<void> {
    if (
      tx.gasPrice !== undefined ||
      (tx.maxFeePerGas !== undefined && tx.maxPriorityFeePerGas !== undefined)
    ) {
      return;
    }
    let suggested = await this.#suggestEip1559Fees();
    if (suggested === undefined && tx.authorizationList !== undefined) {
      throw catalogError(ERRORS.txAuthorizationFees, {}, { operation: method });
    }
    if (
      suggested === undefined &&
      tx.maxFeePerGas === undefined &&
      tx.maxPriorityFeePerGas === undefined
    ) {
      // eth_feeHistory failed: a legacy transaction.
      tx.gasPrice = numberToHexString(await this.#gasPrice());
      return;
    }
    // eth_feeHistory failed, but the caller set one EIP-1559 field: both default to the gas price.
    if (suggested === undefined) {
      const gasPrice = await this.#gasPrice();
      suggested = { maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice };
    }
    // Like Hardhat, only a string counts as a caller's value; any other value is replaced.
    let maxFeePerGas =
      typeof tx.maxFeePerGas === "string"
        ? hexStringToBigInt(tx.maxFeePerGas)
        : suggested.maxFeePerGas;
    const maxPriorityFeePerGas =
      typeof tx.maxPriorityFeePerGas === "string"
        ? hexStringToBigInt(tx.maxPriorityFeePerGas)
        : suggested.maxPriorityFeePerGas;
    if (maxFeePerGas < maxPriorityFeePerGas) {
      maxFeePerGas += maxPriorityFeePerGas;
    }
    tx.maxFeePerGas = numberToHexString(maxFeePerGas);
    tx.maxPriorityFeePerGas = numberToHexString(maxPriorityFeePerGas);
  }

  async #gasPrice(): Promise<bigint> {
    const price = await this.#request("eth_gasPrice");
    return hexStringToBigInt(stringResult(price, "eth_gasPrice", "eth_gasPrice"));
  }

  /**
   * AutomaticGasPriceHandler#suggestEip1559FeePriceValues, with one difference. Hardhat remembers
   * any failed or unreadable `eth_feeHistory` for the rest of the connection and sends every later
   * transaction as legacy, so one transient failure would downgrade every send on the connection.
   * The filler remembers only a "method not found" (-32601). After any other failure or an answer
   * it cannot read, it asks once more, then falls back to a legacy gas price for this transaction
   * only. A timeout is not asked again: the send already waited the network's whole timeout.
   */
  async #suggestEip1559Fees(): Promise<Eip1559Fees | undefined> {
    if (this.#nodeSupportsEip1559 === undefined) {
      const block = await this.#request("eth_getBlockByNumber", ["latest", false]);
      if (!isObject(block)) {
        throw catalogError(ERRORS.txNoLatestBlock, {}, { operation: "eth_getBlockByNumber" });
      }
      this.#nodeSupportsEip1559 = block.baseFeePerGas !== undefined;
    }
    if (this.#nodeHasFeeHistory === false || !this.#nodeSupportsEip1559) {
      return undefined;
    }
    const first = await this.#feesFromHistory();
    const fees = first === "retry" ? await this.#feesFromHistory() : first;
    return fees === "retry" ? undefined : fees;
  }

  /**
   * One `eth_feeHistory` read: the suggested fees, `"retry"` after a failure that may be
   * transient or an answer it cannot read, or undefined when asking again would not help.
   */
  async #feesFromHistory(): Promise<Eip1559Fees | "retry" | undefined> {
    let history: unknown;
    try {
      history = await this.#request("eth_feeHistory", ["0x1", "latest", [REWARD_PERCENTILE]]);
    } catch (error) {
      if (isObject(error) && error.code === METHOD_NOT_FOUND) {
        this.#nodeHasFeeHistory = false;
        return undefined;
      }
      return HardhatError.isHardhatError(error, HardhatError.ERRORS.CORE.NETWORK.NETWORK_TIMEOUT)
        ? undefined
        : "retry";
    }
    // The answer is read outside the catch, so a malformed answer is handled by the check that
    // reads it.
    const baseFees: unknown = isObject(history) ? history.baseFeePerGas : undefined;
    const rewards: unknown = isObject(history) ? history.reward : undefined;
    if (!Array.isArray(baseFees) || !Array.isArray(rewards)) {
      return "retry";
    }
    let maxPriorityFeePerGas = quantityOf(Array.isArray(rewards[0]) ? rewards[0][0] : undefined);
    if (maxPriorityFeePerGas === undefined) {
      return "retry";
    }
    if (maxPriorityFeePerGas === 0n) {
      maxPriorityFeePerGas = await this.#suggestedPriorityFee();
    }
    // Still 0 on a nearly empty chain, such as a local test network, or without
    // eth_maxPriorityFeePerGas: pay 1 wei.
    if (maxPriorityFeePerGas === 0n) {
      maxPriorityFeePerGas = 1n;
    }
    const lastBaseFee = quantityOf(baseFees.at(-1));
    if (lastBaseFee === undefined) {
      return "retry";
    }
    return {
      maxFeePerGas:
        (lastBaseFee * 9n ** (BASE_FEE_FULL_BLOCKS - 1n)) / 8n ** (BASE_FEE_FULL_BLOCKS - 1n),
      maxPriorityFeePerGas,
    };
  }

  /**
   * The node's eth_maxPriorityFeePerGas, or 0 when it has none or answers with something other
   * than a hex quantity, as Hardhat's catch does.
   */
  async #suggestedPriorityFee(): Promise<bigint> {
    try {
      return quantityOf(await this.#request("eth_maxPriorityFeePerGas", [])) ?? 0n;
    } catch {
      return 0n;
    }
  }

  /**
   * `eth_estimateGas` at the `pending` block, the state the pending nonce counts. Hardhat, viem and
   * ethers send no block tag, so most nodes use `latest`. A node whose `latest` lags the account's
   * pending transactions then simulates with a stale nonce and skips a self-sponsored EIP-7702
   * authorization, which EIP-7702 ignores rather than fails: the estimate is too low and the
   * transaction runs out of gas (#492). When the node refuses the tag, or the tag is undefined (a
   * replacement), the request is sent as Hardhat sends it.
   */
  async #requestEstimate(params: unknown[], tag: "pending" | undefined): Promise<unknown> {
    if (tag === undefined) {
      return await this.#request("eth_estimateGas", params);
    }
    const [tx] = params;
    try {
      return await this.#request("eth_estimateGas", [tx, tag]);
    } catch (error) {
      if (!refusesPendingTag(error)) {
        throw error;
      }
      return await this.#request("eth_estimateGas", params);
    }
  }

  /** MultipliedGasEstimation#getMultipliedGasEstimation, with the estimate at `tag`. */
  async #estimateGas(params: unknown[], tag: "pending" | undefined): Promise<string> {
    try {
      const estimate = stringResult(
        await this.#requestEstimate(params, tag),
        "eth_estimateGas",
        "eth_estimateGas",
      );
      if (this.#settings.gasMultiplier === 1) {
        return estimate;
      }
      const gasLimit = await this.#cappedBlockGasLimit();
      const multiplied = Math.floor(hexStringToNumber(estimate) * this.#settings.gasMultiplier);
      return numberToHexString(multiplied > gasLimit ? gasLimit - 1 : multiplied);
    } catch (error) {
      // The caller never asked for the estimate, so a known default beats a failure. Only an
      // in-process simulated network exposes its default gas limit; elsewhere the error stands.
      const { fallbackGas } = this.#settings;
      if (error instanceof Error && fallbackGas !== undefined && isInternalCallOutOfGas(error)) {
        if (!this.#settings.isBlockGasLimitEnforced()) {
          return numberToHexString(fallbackGas);
        }
        // The pending block, not the cache: evm_setBlockGasLimit may have just lowered it.
        const pending = BigInt(await this.#fetchBlockGasLimit("pending"));
        return numberToHexString(min(fallbackGas, pending));
      }
      if (error instanceof Error && error.message.toLowerCase().includes("execution error")) {
        return numberToHexString(await this.#cappedBlockGasLimit());
      }
      throw error;
    }
  }

  async #cappedBlockGasLimit(): Promise<number> {
    // A margin below the latest block's limit, which can vary a little between blocks.
    this.#blockGasLimit ??= Math.floor(
      (await this.#fetchBlockGasLimit("latest")) * BLOCK_GAS_LIMIT_SAFETY_FACTOR,
    );
    return this.#blockGasLimit;
  }

  async #fetchBlockGasLimit(blockTag: "latest" | "pending"): Promise<number> {
    const block = await this.#request("eth_getBlockByNumber", [blockTag, false]);
    const gasLimit: unknown = isObject(block) ? block.gasLimit : undefined;
    if (typeof gasLimit !== "string") {
      throw catalogError(
        ERRORS.txNoBlockGasLimit,
        { blockTag },
        { operation: "eth_getBlockByNumber" },
      );
    }
    return hexStringToNumber(gasLimit);
  }
}

/** micro-eth-signer's name of a transaction type that KMS accounts sign. */
type SignedTypeName = "legacy" | "eip2930" | "eip1559" | "eip7702";

/** The transaction types KMS accounts sign, by number, with micro-eth-signer's names. */
export const SIGNED_TYPES: Readonly<Record<number, SignedTypeName>> = {
  0: "legacy",
  1: "eip2930",
  2: "eip1559",
  4: "eip7702",
};

/**
 * Names a transaction type by its number and micro-eth-signer's name, such as `0x2 (eip1559)`.
 *
 * @param name - micro-eth-signer's name of the type.
 * @returns The description.
 */
export function describeType(name: string): string {
  const number = Object.entries(SIGNED_TYPES).find(([, type]) => type === name)?.[0];
  return number === undefined ? name : `0x${number} (${name})`;
}

// A type as a hex quantity (either case, any leading zeros) or a decimal string, once trimmed.
const QUANTITY_TYPE = /^(?:0x[0-9a-f]+|[0-9]+)$/i;
// viem's name of type 3.
const BLOB_TYPE_NAME = /^eip4844$/i;

/**
 * The number of a request's `type`, in any numeric form a JSON-RPC caller can pass: a hex
 * quantity in either case, with or without leading zeros, a decimal string, a non-negative
 * integer or a non-negative bigint. Strings are trimmed first. Any other value, such as viem's
 * `"legacy"`, is not a number: the fields decide the type, as in Hardhat's local accounts. With
 * hardhat-zod-utils 3.0.7 or later, those refuse a `type` that is not a `0x` quantity without
 * leading zeros; the filler keeps it out of the copy it validates with that schema.
 *
 * @param type - The request's `type`.
 * @returns Its number, or undefined.
 */
function typeNumber(type: unknown): bigint | undefined {
  if (typeof type === "string") {
    const text = type.trim();
    return QUANTITY_TYPE.test(text) ? BigInt(text) : undefined;
  }
  if (typeof type === "number") {
    return Number.isSafeInteger(type) && type >= 0 ? BigInt(type) : undefined;
  }
  return typeof type === "bigint" && type >= 0n ? type : undefined;
}

/**
 * Whether a request's `type` asks for a blob transaction (EIP-4844, type 3): the number 3 in any
 * form {@link typeNumber} reads, or viem's name, trimmed and in either case.
 *
 * @param type - The request's `type`.
 * @returns Whether it is type 3.
 */
export function isBlobType(type: unknown): boolean {
  return typeNumber(type) === 3n || (typeof type === "string" && BLOB_TYPE_NAME.test(type.trim()));
}

/**
 * The type a request's own fields give, as {@link buildUnsignedTransaction} picks it once the
 * fees are filled: EIP-7702 with an authorization list, else EIP-1559 with an EIP-1559 fee field,
 * else EIP-2930 with an access list, else legacy. Only called when the caller set a fee field,
 * which the fill never changes into a field of another type.
 *
 * @param tx - The request's transaction.
 * @returns micro-eth-signer's name of the type.
 */
function fieldsType(tx: Record<string, unknown>): SignedTypeName {
  if (tx.authorizationList !== undefined) {
    return "eip7702";
  }
  if (tx.maxFeePerGas !== undefined || tx.maxPriorityFeePerGas !== undefined) {
    return "eip1559";
  }
  return tx.accessList === undefined ? "legacy" : "eip2930";
}

// The fields that decide a transaction's type, apart from `type`.
const TYPE_FIELDS = [
  "gasPrice",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "accessList",
  "authorizationList",
] as const;

/** Names fields in prose: `a`, `a and b`. */
function fieldNames(fields: readonly string[]): string {
  return fields.join(" and ");
}

/**
 * What to change in a request that asks for one type but has the fields of another (#504): only
 * the fields the caller set are named. Every mismatch has at least one change, as the type the
 * fields give differs from the one asked for.
 *
 * @param name - micro-eth-signer's name of the type asked for.
 * @param tx - The request's transaction. Its only `null` field that decides the type, if any, is a
 *   lone EIP-1559 fee field the fill replaces, which counts as set.
 * @returns The hint, a sentence.
 */
function typeFix(name: SignedTypeName, tx: Record<string, unknown>): string {
  const isSet = (field: string): boolean => tx[field] !== undefined;
  const eip1559Fees = ["maxFeePerGas", "maxPriorityFeePerGas"].filter(isSet);
  const changes: string[] = [];
  if (name === "legacy" || name === "eip2930") {
    if (eip1559Fees.length > 0) {
      changes.push(
        isSet("gasPrice")
          ? `remove ${fieldNames(eip1559Fees)}`
          : `set gasPrice instead of ${fieldNames(eip1559Fees)}`,
      );
    }
    if (name === "legacy" && isSet("accessList")) {
      changes.push("remove accessList");
    }
    if (isSet("authorizationList")) {
      changes.push("remove authorizationList");
    }
  } else {
    // A request for type 4 whose fields disagree has no authorizationList.
    if (name === "eip7702") {
      changes.push("add an authorizationList");
    }
    if (isSet("gasPrice")) {
      changes.push(
        eip1559Fees.length > 0
          ? "remove gasPrice"
          : "set maxFeePerGas and maxPriorityFeePerGas instead of gasPrice",
      );
    }
    if (isSet("authorizationList")) {
      changes.push("remove authorizationList");
    }
  }
  const text = `${changes.join(", ")}, or remove type.`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Whether the automatic fee fill replaces a `null` in `field` with a suggested fee, as Hardhat
 * does: only a lone EIP-1559 fee field, with no `gasPrice` and the other EIP-1559 field absent.
 * Any other `null` reaches the schema, which refuses it.
 *
 * @param tx - The request's transaction.
 * @param field - A field that decides the type.
 * @param autoFees - Whether the network's `gasPrice` setting is `"auto"`.
 * @returns Whether the fill replaces the field's `null`.
 */
function feeFillReplaces(tx: Record<string, unknown>, field: string, autoFees: boolean): boolean {
  if (!autoFees || tx.gasPrice !== undefined) {
    return false;
  }
  if (field === "maxFeePerGas") {
    return tx.maxPriorityFeePerGas === undefined;
  }
  return field === "maxPriorityFeePerGas" && tx.maxFeePerGas === undefined;
}

/**
 * Refuses a `null` in a field that decides the type (#504), before any request to the node, with
 * an error that names the field. Only a `null` the schema would refuse after the fill is refused;
 * one the automatic fee fill replaces (see {@link feeFillReplaces}) is kept, and signs as before.
 *
 * @param tx - The request's transaction.
 * @param method - The RPC method, for the error message.
 * @param autoFees - Whether the network's `gasPrice` setting is `"auto"`.
 */
function refuseNullTypeFields(
  tx: Record<string, unknown>,
  method: string,
  autoFees: boolean,
): void {
  const field = TYPE_FIELDS.find(
    (name) => tx[name] === null && !feeFillReplaces(tx, name, autoFees),
  );
  if (field !== undefined) {
    throw catalogError(ERRORS.txNullField, { field }, { operation: method });
  }
}

/**
 * Applies a request's `type` (#496), before any request to the node. A number other than 0, 1, 2
 * and 4 is refused (type 3 is refused before, as a blob transaction). When the caller set a fee
 * field, a type other than the one the fields give is refused, except type 1 with `gasPrice` and
 * no `accessList`: that is a valid EIP-2930 transaction with an empty access list, which viem's
 * `eip2930` and ethers' `type: 1` send, so the list is set to `[]`. A `type` with no fee field is
 * not checked: the fill chooses the fees and the type follows them, as Hardhat's local accounts
 * do. A `type` that is not a number is ignored. A `null` field that decides the type is refused,
 * with or without a `type`, after the unsupported type and before the mismatch, unless the fee
 * fill replaces it. Such a lone `null` EIP-1559 fee field counts as an EIP-1559 fee field here,
 * since the fill makes it one: `type: "0x0"` with `maxFeePerGas: null` is a mismatch.
 *
 * @param tx - The copied transaction; its `accessList` may be set.
 * @param method - The RPC method, for error messages.
 * @param autoFees - Whether the network's `gasPrice` setting is `"auto"`.
 */
function applyRequestedType(tx: Record<string, unknown>, method: string, autoFees: boolean): void {
  const requested = typeNumber(tx.type);
  // Without a number, the lookup is of NaN, which has no type.
  const name: SignedTypeName | undefined = SIGNED_TYPES[Number(requested)];
  if (requested !== undefined && name === undefined) {
    throw catalogError(
      ERRORS.txUnsupportedType,
      { type: `0x${requested.toString(16)}` },
      { operation: method },
    );
  }
  refuseNullTypeFields(tx, method, autoFees);
  if (
    name === undefined ||
    (tx.gasPrice === undefined &&
      tx.maxFeePerGas === undefined &&
      tx.maxPriorityFeePerGas === undefined)
  ) {
    return;
  }
  const actual = fieldsType(tx);
  if (name === "eip2930" && actual === "legacy") {
    tx.accessList = [];
    return;
  }
  if (actual !== name) {
    throw catalogError(
      ERRORS.txRequestTypeMismatch,
      {
        requested: describeType(name),
        actual: describeType(actual),
        hint: typeFix(name, tx),
      },
      { operation: method },
    );
  }
}

/**
 * Copies a request's params deeply with `structuredClone`, which runs each getter once. A
 * transaction that is not plain data (JSON values, bigints and byte arrays) is refused.
 *
 * @param params - The request's params.
 * @param method - The RPC method, for the error message.
 * @returns The copy.
 */
function copyParams(params: readonly unknown[], method: string): unknown[] {
  try {
    return structuredClone([...params]);
  } catch {
    throw notPlainData(method);
  }
}

// A JSON-RPC quantity of at most 32 bytes (execution-apis `uint256`): no leading zeros. Only
// matched against values that canonicalAuthorizationSignatures wrote, which are lowercase.
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/;
// An authorization's r or s as callers send it: a quantity (viem) or 32 bytes (Hardhat's schema).
const SIGNATURE_SCALAR = /^0x(?:0|[1-9a-f][0-9a-f]{0,63}|[0-9a-f]{64})$/i;
const CURVE_ORDER = secp256k1.Point.CURVE().n;

/**
 * Rewrites each authorization's `r` and `s` as a JSON-RPC quantity, the form the execution APIs
 * specify (`uint256`) and nodes such as geth require. viem sends quantities (`numberToHex`), which
 * drop leading zero bytes; Hardhat's schema wants 32 bytes. About one authorization in 85 has a
 * leading zero byte in `r` (1 in 256) or in its low-S `s` (1 in 128), so either form must work
 * (#140). A value outside [1, n - 1] is refused here, before any request to the node. A value in
 * neither form stays as it is, for the schema to refuse. No other field changes.
 *
 * @param tx - The copied transaction; its authorization list is changed in place.
 * @param method - The RPC method, for error messages.
 */
function canonicalAuthorizationSignatures(tx: Record<string, unknown>, method: string): void {
  const list: unknown = tx.authorizationList;
  if (!Array.isArray(list)) {
    return;
  }
  for (const [index, item] of list.entries()) {
    if (!isObject(item)) {
      continue;
    }
    for (const field of ["r", "s"]) {
      const value = item[field];
      if (typeof value !== "string" || !SIGNATURE_SCALAR.test(value)) {
        continue;
      }
      const scalar = BigInt(value);
      if (scalar < 1n || scalar >= CURVE_ORDER) {
        throw catalogError(ERRORS.txAuthorizationScalar, { index, field }, { operation: method });
      }
      item[field] = numberToHexString(scalar);
    }
  }
}

/**
 * A copy of the transaction whose authorizations have `r` and `s` left-padded to 32 bytes, for
 * Hardhat's schema, whose `rpcHash` accepts only 32 bytes. The node never sees this form.
 *
 * @param tx - The transaction, with quantities from {@link canonicalAuthorizationSignatures}.
 * @returns The copy, or `tx` when it has no authorization list.
 */
function withPaddedAuthorizationSignatures(tx: Record<string, unknown>): Record<string, unknown> {
  const list: unknown = tx.authorizationList;
  if (!Array.isArray(list)) {
    return tx;
  }
  const authorizationList = list.map((item: unknown) => {
    if (!isObject(item)) {
      return item;
    }
    const copy = { ...item };
    for (const field of ["r", "s"]) {
      const value = copy[field];
      if (typeof value === "string" && QUANTITY.test(value)) {
        copy[field] = `0x${value.slice(2).padStart(64, "0")}`;
      }
    }
    return copy;
  });
  return { ...tx, authorizationList };
}

/**
 * The error for a KMS account's transaction that `structuredClone` cannot copy.
 *
 * @param method - The RPC method, for the error message.
 * @returns The error to throw.
 */
export function notPlainData(method: string): HardhatPluginError {
  return catalogError(ERRORS.txNotPlainData, {}, { operation: method });
}

/**
 * Reads a hex quantity from a node's answer, as `hexStringToBigInt` does, without throwing.
 *
 * @param value - The answer.
 * @returns The number, or `undefined` when the answer is not a hex string.
 */
function quantityOf(value: unknown): bigint | undefined {
  // isHexString does not narrow the type; String() returns the same string.
  return isHexString(value) ? hexStringToBigInt(String(value)) : undefined;
}

/**
 * Reads a string from a node's answer.
 *
 * @param value - The answer.
 * @param what - What was asked for, for the error message.
 * @param operation - The operation, for the error message.
 * @returns The string.
 */
export function stringResult(value: unknown, what: string, operation: string): string {
  if (typeof value !== "string") {
    throw catalogError(ERRORS.nodeAnswerNotString, { what }, { operation });
  }
  return value;
}

/**
 * The gas of a filled request. The gas step of {@link HardhatTransactionFiller.fill} always sets
 * it; this keeps Hardhat's check and narrows the type.
 *
 * @param request - The validated request.
 * @param method - The RPC method, for the error message.
 * @returns The gas.
 */
export function requireGas(request: RpcTransactionRequest, method: string): bigint {
  if (request.gas === undefined) {
    throw catalogError(ERRORS.txNoGas, {}, { operation: method });
  }
  return request.gas;
}

/**
 * The fee checks of LocalAccountsHandler#modifyRequest, in its order.
 *
 * @param request - The validated request.
 * @param method - The RPC method, for error messages.
 */
export function checkFeeFields(request: RpcTransactionRequest, method: string): void {
  const hasGasPrice = request.gasPrice !== undefined;
  const hasEip1559Fields =
    request.maxFeePerGas !== undefined || request.maxPriorityFeePerGas !== undefined;
  const details = { operation: method };
  // Unreachable through fill, which always sets a fee; kept as Hardhat's check.
  if (!hasGasPrice && !hasEip1559Fields) {
    throw catalogError(ERRORS.txNoFee, {}, details);
  }
  if (hasGasPrice && request.authorizationList !== undefined) {
    throw catalogError(ERRORS.txGasPrice7702, {}, details);
  }
  if (hasGasPrice && hasEip1559Fields) {
    throw catalogError(ERRORS.txBothFees, {}, details);
  }
  if (hasEip1559Fields && request.maxFeePerGas === undefined) {
    throw catalogError(ERRORS.txNoMaxFee, {}, details);
  }
  if (hasEip1559Fields && request.maxPriorityFeePerGas === undefined) {
    throw catalogError(ERRORS.txNoPriorityFee, {}, details);
  }
}

/**
 * Reads a connection's fill settings the way Hardhat's `createHandlersArray` does. Only an
 * in-process simulated network's provider exposes a default gas limit, which becomes the
 * fallback; a provider that does not say whether it enforces the block gas limit is assumed to.
 *
 * @param connection - The network connection.
 * @returns The settings.
 */
export function fillSettings(connection: NetworkConnection<string>): FillSettings {
  const { networkConfig, provider } = connection;
  return {
    gas: networkConfig.gas,
    gasPrice: networkConfig.gasPrice,
    gasMultiplier: networkConfig.gasMultiplier,
    fallbackGas:
      "defaultTransactionGasLimit" in provider &&
      typeof provider.defaultTransactionGasLimit === "bigint"
        ? provider.defaultTransactionGasLimit
        : undefined,
    // Read on each use, as Hardhat does: enforcement can change while the connection is open.
    isBlockGasLimitEnforced: () =>
      !("isBlockGasLimitEnforced" in provider) || provider.isBlockGasLimitEnforced !== false,
  };
}

/**
 * Creates the transaction filler of a network connection. Its requests go through
 * `connection.provider`, so they pass through the hook chain to Hardhat's built-in handlers.
 *
 * @param connection - The network connection.
 * @param chain - The connection's chain.
 * @returns The filler.
 */
export function createTransactionFiller(
  connection: NetworkConnection<string>,
  chain: ConnectionChain,
): TransactionFiller {
  return new HardhatTransactionFiller(
    async (method, params) => {
      const result: unknown = await connection.provider.request(
        params === undefined ? { method } : { method, params },
      );
      return result;
    },
    async () => await chain.chainId(),
    fillSettings(connection),
  );
}

/**
 * Builds the unsigned transaction field for field like Hardhat's
 * `LocalAccountsHandler#getSignedTransaction`, with micro-eth-signer's strict mode off. The type
 * follows from the fields: `authorizationList` gives EIP-7702, `maxFeePerGas` EIP-1559,
 * `accessList` EIP-2930, and anything else a legacy transaction.
 *
 * @param tx - A filled transaction.
 * @returns The unsigned transaction.
 */
export function buildUnsignedTransaction(tx: FilledTransaction): UnsignedTransaction {
  const accessList = tx.accessList?.map(({ address, storageKeys }) => ({
    address: addr.addChecksum(bytesToHexString(address)),
    storageKeys: storageKeys === null ? [] : storageKeys.map((key) => bytesToHexString(key)),
  }));
  const authorizationList = tx.authorizationList?.map(
    ({ chainId, address, nonce, yParity, r, s }) => ({
      chainId,
      address: addr.addChecksum(bytesToHexString(address)),
      nonce,
      yParity: bytesToNumber(yParity),
      r: bytesToBigInt(r),
      s: bytesToBigInt(s),
    }),
  );
  if ((tx.to === undefined || tx.to === null) && tx.data === undefined) {
    throw catalogError(ERRORS.txCreationNoData, {}, { operation: "sign transaction" });
  }
  // Hardhat's own comment: strict mode is not meant to be used in the context of Hardhat.
  const strict = false;
  const base = {
    to: addr.addChecksum(bytesToHexString(tx.to ?? new Uint8Array()), true),
    nonce: tx.nonce,
    chainId: tx.chainId,
    value: tx.value ?? 0n,
    data: bytesToHexString(tx.data ?? new Uint8Array()),
    gasLimit: tx.gas,
  };
  const { maxFeePerGas, maxPriorityFeePerGas } = tx;
  if (maxFeePerGas !== undefined || authorizationList !== undefined) {
    if (maxFeePerGas === undefined || maxPriorityFeePerGas === undefined) {
      throw catalogError(ERRORS.txBothMaxFees, {}, { operation: "sign transaction" });
    }
    const fees = { ...base, maxFeePerGas, maxPriorityFeePerGas, accessList: accessList ?? [] };
    return authorizationList === undefined
      ? Transaction.prepare({ type: "eip1559", ...fees }, strict)
      : Transaction.prepare({ type: "eip7702", ...fees, authorizationList }, strict);
  }
  const gasPrice = tx.gasPrice ?? 0n;
  return accessList === undefined
    ? Transaction.prepare({ type: "legacy", ...base, gasPrice }, strict)
    : Transaction.prepare({ type: "eip2930", ...base, gasPrice, accessList }, strict);
}

/**
 * The digest a signer signs for a transaction: keccak-256 of its unsigned encoding, as
 * micro-eth-signer's `Transaction#signBy` computes it.
 *
 * @param tx - The unsigned transaction.
 * @returns The 32-byte digest.
 */
export function signingHash(tx: UnsignedTransaction): Uint8Array {
  return keccak_256(tx.toBytes(false));
}
