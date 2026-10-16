// checkPreparedCalls: reads what `prepareCalls` of `@alchemy/wallet-apis` returned and refuses it
// unless the key would sign exactly the requested calls. `@alchemy/wallet-apis` 5.3.0 signs the
// hash in Alchemy's response as given (src/actions/signPreparedCalls.ts), so this check is what
// ties that hash to the calls. viem is an optional peer of hardhat-kms; only this subpath loads it.
import { isObject } from "@nomicfoundation/hardhat-utils/lang";
import {
  decodeFunctionData,
  encodeFunctionData,
  isAddress,
  isAddressEqual,
  isHex,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import {
  entryPoint07Address,
  getUserOperationHash,
  type UserOperation,
} from "viem/account-abstraction";

import { ERRORS } from "../error-catalog.ts";
import { catalogError } from "../errors.ts";
import type { KmsHex } from "../viem/types.ts";

/** A call as you give it to `prepareCalls`. */
export interface RequestedCall {
  /** The address the call goes to: lowercase, or with a valid EIP-55 checksum. */
  readonly to: string;
  /** The value in wei; a missing value is 0. */
  readonly value?: bigint | undefined;
  /** The call data; missing data is `0x`. */
  readonly data?: KmsHex | undefined;
}

/** What you asked `prepareCalls` for, and what the key's account looks like on chain. */
export interface PreparedCallsExpectation {
  /** The calls you gave `prepareCalls`, in the same order. */
  readonly calls: readonly RequestedCall[];
  /** The key's address: the EIP-7702 account that sends the calls. */
  readonly sender: string;
  /** Your chain's id. The user operation hash is computed with it, not with the returned one. */
  readonly chainId: number;
  /**
   * The only contract the account may be delegated to, such as Modular Account v2 v1.1.0 at
   * `0x77021100bD87b7008E5E1989d0eB38555d0d0000`.
   */
  readonly delegate: string;
  /**
   * The account's code now, as `getCode` returns it: `undefined` or `0x` when it has none, or
   * `0xef0100` and the delegate's address when it is delegated.
   */
  readonly accountCode: KmsHex | undefined;
  /** Whether you passed a gas sponsorship policy id to the client or to `prepareCalls`. */
  readonly sponsored: boolean;
  /**
   * The most the user operation may cost the account, in wei: its gas limits (call,
   * verification, pre-verification and any paymaster limits) times `maxFeePerGas`, which is what
   * EntryPoint v0.7 takes from the account up front. Required when `sponsored` is `false`, since
   * the account then pays the bundler whatever gas price and limits the response names. Checked
   * whenever it is given.
   */
  readonly maxGasCost?: bigint | undefined;
  /**
   * The account's nonce now, as `getTransactionCount` returns it. When it is given, an
   * authorization must be for this nonce. Without it, the authorization's nonce is not checked: a
   * wrong one only makes the send fail, but a later one leaves a signed delegation to `delegate`
   * that anyone can apply once the account reaches that nonce.
   */
  readonly accountNonce?: number | bigint | undefined;
}

/** The selector `executeUserOp` puts before the account call in EntryPoint v0.7 callData. */
const EXECUTE_USER_OP_SELECTOR = "0x8dd7712f";
/** The code of an account that EIP-7702 delegated: this prefix, then the delegate's address. */
const DELEGATION_PREFIX = "0xef0100";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ADDRESS_FORM = "an address: 0x and 40 hex digits, lowercase or with a valid EIP-55 checksum";

/** The response and signature request types a message may name; others are "unknown". */
const KNOWN_TYPES: ReadonlySet<unknown> = new Set([
  "array",
  "authorization",
  "paymaster-permit",
  "solana-transaction-v0",
  "user-operation-v060",
  "user-operation-v070",
  "eip7702Auth",
  "eth_signTypedData_v4",
  "personal_sign",
]);

/** Modular Account v2's two plain call functions; anything else in callData is refused. */
const ACCOUNT_ABI = parseAbi([
  "function execute(address target, uint256 value, bytes data)",
  "function executeBatch((address target, uint256 value, bytes data)[] calls)",
]);

/** An object read from the response. */
type Fields = Record<string | symbol, unknown>;

/** A user operation's fields, as `prepareCalls` returns them. */
interface PreparedUserOperation {
  readonly chainId: number;
  readonly userOperation: UserOperation<"0.7">;
  readonly hash: unknown;
  readonly signatureType: string;
  readonly sponsored: unknown;
}

/** A call: requested, or read from callData. */
interface Call {
  readonly to: Address;
  readonly value: bigint;
  readonly data: Hex;
}

/**
 * Checks a response of `prepareCalls` from `@alchemy/wallet-apis` before the key signs it, and
 * throws when the key would sign anything other than the calls you asked for.
 *
 * It accepts a `user-operation-v070`, or an `array` of one `user-operation-v070` and at most one
 * EIP-7702 `authorization`, and requires:
 *
 * - a `personal_sign` signature request over a raw hash (`{ raw }`), never typed data;
 * - the user operation and the authorization on your chain, from `sender`, with no factory;
 * - the EntryPoint v0.7 user operation hash, recomputed with your `chainId`, equal to the hash in
 *   the signature request;
 * - `callData` that is Modular Account v2 `execute` or `executeBatch`, optionally behind the
 *   `executeUserOp` selector `0x8dd7712f`, with exactly your calls, in order;
 * - with `sponsored`, a paymaster and `feePayment.sponsored`;
 * - a maximum gas cost no higher than `maxGasCost`, which is required without `sponsored`;
 * - an authorization only to `delegate`, and only when the account has no code or is already
 *   delegated to `delegate`; without one, the account must already be delegated to `delegate`;
 * - with `accountNonce`, an authorization for that nonce.
 *
 * Call it between `prepareCalls` and `signPreparedCalls`. It reads no chain state itself: pass the
 * account's code and nonce, read with `getCode` and `getTransactionCount` just before
 * `prepareCalls`.
 *
 * @param prepared - What `client.prepareCalls(...)` returned, unchanged.
 * @param expected - What you asked for.
 * @throws A `HardhatPluginError` that names the first check that failed; nothing was signed.
 */
export function checkPreparedCalls(prepared: unknown, expected: PreparedCallsExpectation): void {
  const calls = readExpectedCalls(expected.calls);
  const sender = readExpectedAddress(expected.sender, "sender");
  const delegate = readExpectedAddress(expected.delegate, "delegate");
  if (isAddressEqual(delegate, ZERO_ADDRESS)) {
    throw catalogError(ERRORS.alchemyInput, {
      field: "delegate",
      expected: "a contract address, not the zero address",
    });
  }
  const chainId = expected.chainId;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw catalogError(ERRORS.alchemyInput, { field: "chainId", expected: "a positive integer" });
  }
  const accountCode = readAccountCode(expected.accountCode);
  if (typeof expected.sponsored !== "boolean") {
    throw catalogError(ERRORS.alchemyInput, { field: "sponsored", expected: "true or false" });
  }
  const maxGasCost = expected.maxGasCost;
  if (
    (maxGasCost === undefined && !expected.sponsored) ||
    (maxGasCost !== undefined && (typeof maxGasCost !== "bigint" || maxGasCost < 0n))
  ) {
    throw catalogError(ERRORS.alchemyInput, {
      field: "maxGasCost",
      expected: "a non-negative bigint in wei, required when sponsored is false",
    });
  }
  const accountNonce = expected.accountNonce;
  if (
    accountNonce !== undefined &&
    !(typeof accountNonce === "bigint"
      ? accountNonce >= 0n
      : Number.isSafeInteger(accountNonce) && accountNonce >= 0)
  ) {
    throw catalogError(ERRORS.alchemyInput, {
      field: "accountNonce",
      expected: "a non-negative integer, as getTransactionCount returns it",
    });
  }

  const { userOperation, authorization } = splitPrepared(prepared);
  const operation = readUserOperation(userOperation);
  if (operation.signatureType !== "personal_sign") {
    throw catalogError(ERRORS.alchemySignatureRequest, { type: operation.signatureType });
  }
  if (!isHex(operation.hash)) {
    throw catalogError(ERRORS.alchemySignatureText, {});
  }
  if (operation.chainId !== chainId) {
    throw catalogError(ERRORS.alchemyChain, {
      part: "user operation",
      returned: operation.chainId,
      expected: chainId,
    });
  }
  const op = operation.userOperation;
  if (!isAddressEqual(op.sender, sender)) {
    throw catalogError(ERRORS.alchemySender, { returned: op.sender, expected: sender });
  }
  if (op.factory !== undefined || op.factoryData !== undefined) {
    throw catalogError(ERRORS.alchemyFactory, {});
  }
  // viem returns the hash in lowercase.
  const hash = getUserOperationHash({
    chainId,
    entryPointAddress: entryPoint07Address,
    entryPointVersion: "0.7",
    userOperation: op,
  });
  if (hash !== operation.hash.toLowerCase()) {
    throw catalogError(ERRORS.alchemyHash, { chainId });
  }
  compareCalls(decodeCalls(op.callData), calls);
  if (expected.sponsored) {
    if (op.paymaster === undefined || isAddressEqual(op.paymaster, ZERO_ADDRESS)) {
      throw catalogError(ERRORS.alchemyNoPaymaster, {});
    }
    if (operation.sponsored !== true) {
      throw catalogError(ERRORS.alchemyNotSponsored, {});
    }
  }
  // What EntryPoint v0.7 takes from the account up front; without a cap, nothing to compare.
  const gas =
    op.callGasLimit +
    op.verificationGasLimit +
    op.preVerificationGas +
    (op.paymasterVerificationGasLimit ?? 0n) +
    (op.paymasterPostOpGasLimit ?? 0n);
  const cost = gas * op.maxFeePerGas;
  const cap = maxGasCost ?? cost;
  if (cost > cap) {
    throw catalogError(ERRORS.alchemyGasCost, { cost, max: cap });
  }
  checkDelegation(authorization, { chainId, delegate, accountCode, accountNonce });
}

/** Reads the requested calls: at least one, each with an address, a value and hex data. */
function readExpectedCalls(calls: unknown): Call[] {
  if (!Array.isArray(calls) || calls.length === 0) {
    throw catalogError(ERRORS.alchemyInput, {
      field: "calls",
      expected: "a non-empty array of { to, value?, data? }",
    });
  }
  return calls.map((call: unknown, index) => {
    const field = `calls[${String(index)}]`;
    if (!isObject(call)) {
      throw catalogError(ERRORS.alchemyInput, {
        field,
        expected: "an object { to, value?, data? }",
      });
    }
    const to = readExpectedAddress(call.to, `${field}.to`);
    const value = call.value ?? 0n;
    if (typeof value !== "bigint" || value < 0n) {
      throw catalogError(ERRORS.alchemyInput, {
        field: `${field}.value`,
        expected: "a non-negative bigint",
      });
    }
    const data = call.data ?? "0x";
    if (!isHex(data) || data.length % 2 !== 0) {
      throw catalogError(ERRORS.alchemyInput, {
        field: `${field}.data`,
        expected: "0x and an even number of hex digits",
      });
    }
    return { to, value, data };
  });
}

function readExpectedAddress(value: unknown, field: string): Address {
  const address = addressOf(value);
  if (address === undefined) {
    throw catalogError(ERRORS.alchemyInput, { field, expected: ADDRESS_FORM });
  }
  return address;
}

/** The value as an address, if it is one: lowercase, or with a valid EIP-55 checksum. */
function addressOf(value: unknown): Address | undefined {
  return typeof value === "string" && isAddress(value) ? value : undefined;
}

/** Reads the account's code; `0x` and `undefined` both mean no code. */
function readAccountCode(code: unknown): Hex {
  const value = code ?? "0x";
  if (!isHex(value) || value.length % 2 !== 0) {
    throw catalogError(ERRORS.alchemyInput, {
      field: "accountCode",
      expected: "the hex code that getCode returns, or undefined",
    });
  }
  return value;
}

/** Splits the response into its user operation and its authorization, refusing other shapes. */
function splitPrepared(prepared: unknown): {
  userOperation: Fields;
  authorization: Fields | undefined;
} {
  if (!isObject(prepared)) {
    throw catalogError(ERRORS.alchemyResponseType, { type: describeType(undefined) });
  }
  const type = prepared.type;
  if (type === "user-operation-v070") {
    return { userOperation: prepared, authorization: undefined };
  }
  const data = prepared.data;
  if (type !== "array" || !Array.isArray(data)) {
    throw catalogError(ERRORS.alchemyResponseType, { type: describeType(type) });
  }
  const operations: Fields[] = [];
  const authorizations: Fields[] = [];
  const types: string[] = [];
  for (const item of data) {
    const itemType: unknown = isObject(item) ? item.type : undefined;
    if (isObject(item) && itemType === "user-operation-v070") {
      operations.push(item);
    } else if (isObject(item) && itemType === "authorization") {
      authorizations.push(item);
    }
    types.push(describeType(itemType));
  }
  const [userOperation] = operations;
  const [authorization] = authorizations;
  if (
    userOperation === undefined ||
    operations.length > 1 ||
    authorizations.length > 1 ||
    operations.length + authorizations.length !== data.length
  ) {
    throw catalogError(ERRORS.alchemyResponseType, {
      type: `an array of [${types.join(", ")}]`,
    });
  }
  return { userOperation, authorization };
}

/** Names a response type for a message, without echoing arbitrary text from the response. */
function describeType(type: unknown): string {
  return KNOWN_TYPES.has(type) ? String(type) : "of an unknown type";
}

/** Reads a `user-operation-v070` with the types `prepareCalls` decodes it to. */
function readUserOperation(item: Fields): PreparedUserOperation {
  const chainId = readChainId(item.chainId, "user operation");
  const data = item.data;
  if (!isObject(data)) {
    throw malformed("data");
  }
  const sender = addressOf(data.sender);
  if (sender === undefined) {
    throw malformed("sender");
  }
  const callData = data.callData;
  if (!isHex(callData)) {
    throw malformed("callData");
  }
  const userOperation: UserOperation<"0.7"> = {
    sender,
    nonce: readQuantity(data, "nonce"),
    callData,
    callGasLimit: readQuantity(data, "callGasLimit"),
    verificationGasLimit: readQuantity(data, "verificationGasLimit"),
    preVerificationGas: readQuantity(data, "preVerificationGas"),
    maxFeePerGas: readQuantity(data, "maxFeePerGas"),
    maxPriorityFeePerGas: readQuantity(data, "maxPriorityFeePerGas"),
    // Stryker disable next-line StringLiteral: getUserOperationHash leaves the signature out
    signature: "0x",
    ...optionalAddress(data, "factory"),
    ...optionalHex(data, "factoryData"),
    ...optionalAddress(data, "paymaster"),
    ...optionalHex(data, "paymasterData"),
    ...optionalQuantity(data, "paymasterVerificationGasLimit"),
    ...optionalQuantity(data, "paymasterPostOpGasLimit"),
  };
  const request = item.signatureRequest;
  const requestType: unknown = isObject(request) ? request.type : undefined;
  const message: unknown = isObject(request) ? request.data : undefined;
  const feePayment = item.feePayment;
  return {
    chainId,
    userOperation,
    hash: isObject(message) ? message.raw : undefined,
    signatureType: KNOWN_TYPES.has(requestType)
      ? String(requestType)
      : "missing or unknown kind of",
    sponsored: isObject(feePayment) ? feePayment.sponsored : undefined,
  };
}

function readChainId(value: unknown, part: string): number {
  if (!Number.isSafeInteger(value)) {
    throw catalogError(ERRORS.alchemyMalformed, { part, field: "chainId" });
  }
  return Number(value);
}

function malformed(field: string): Error {
  return catalogError(ERRORS.alchemyMalformed, { part: "user operation", field });
}

function readQuantity(data: Fields, name: string): bigint {
  const value = data[name];
  if (typeof value !== "bigint") {
    throw malformed(name);
  }
  return value;
}

function optionalAddress(
  data: Fields,
  name: "factory" | "paymaster",
): { [field in typeof name]?: Address } {
  const value = data[name];
  if (value === undefined) {
    return {};
  }
  const address = addressOf(value);
  if (address === undefined) {
    throw malformed(name);
  }
  return { [name]: address };
}

function optionalHex(
  data: Fields,
  name: "factoryData" | "paymasterData",
): { [field in typeof name]?: Hex } {
  const value = data[name];
  if (value === undefined) {
    return {};
  }
  if (!isHex(value)) {
    throw malformed(name);
  }
  return { [name]: value };
}

function optionalQuantity(
  data: Fields,
  name: "paymasterVerificationGasLimit" | "paymasterPostOpGasLimit",
): { [field in typeof name]?: bigint } {
  const value = data[name];
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "bigint") {
    throw malformed(name);
  }
  return { [name]: value };
}

/**
 * Reads the calls in a Modular Account v2 callData: `execute` or `executeBatch`, optionally behind
 * the `executeUserOp` selector, in their standard encoding. Anything else is refused.
 */
function decodeCalls(callData: Hex): Call[] {
  // viem matches selectors and encodes in lowercase.
  const lower: Hex = `0x${callData.slice(2).toLowerCase()}`;
  const inner: Hex = lower.startsWith(EXECUTE_USER_OP_SELECTOR)
    ? `0x${lower.slice(EXECUTE_USER_OP_SELECTOR.length)}`
    : lower;
  let decoded: ReturnType<typeof decodeFunctionData<typeof ACCOUNT_ABI>>;
  try {
    decoded = decodeFunctionData({ abi: ACCOUNT_ABI, data: inner });
  } catch {
    throw catalogError(ERRORS.alchemyCallsFunction, {});
  }
  let encoded: Hex;
  if (decoded.functionName === "execute") {
    // Stryker disable next-line StringLiteral: with no name, viem encodes the first function, execute
    encoded = encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "execute", args: decoded.args });
  } else {
    encoded = encodeFunctionData({
      abi: ACCOUNT_ABI,
      functionName: "executeBatch",
      args: decoded.args,
    });
  }
  if (encoded !== inner) {
    throw catalogError(ERRORS.alchemyCallsEncoding, { name: decoded.functionName });
  }
  if (decoded.functionName === "execute") {
    const [to, value, data] = decoded.args;
    return [{ to, value, data }];
  }
  return decoded.args[0].map((call) => ({ to: call.target, value: call.value, data: call.data }));
}

/**
 * Compares the decoded calls with the requested ones: the same count and order, and for each the
 * same `to`, value and data. viem decodes data in lowercase.
 */
function compareCalls(decoded: readonly Call[], requested: readonly Call[]): void {
  const length = Math.max(decoded.length, requested.length);
  for (let index = 0; index < length; index += 1) {
    const call = decoded[index];
    const want = requested[index];
    if (call === undefined || want === undefined) {
      throw catalogError(ERRORS.alchemyCallsCount, {
        returned: decoded.length,
        expected: requested.length,
      });
    }
    const field = !isAddressEqual(call.to, want.to)
      ? "to"
      : call.value !== want.value
        ? "value"
        : call.data !== want.data.toLowerCase()
          ? "data"
          : undefined;
    if (field !== undefined) {
      throw catalogError(ERRORS.alchemyCallsDiffer, { index, field });
    }
  }
}

/**
 * Checks the delegation the user operation runs under: an authorization only to the pinned
 * delegate, and only from no code or the same delegation; without one, the same delegation now.
 */
function checkDelegation(
  authorization: Fields | undefined,
  expected: {
    chainId: number;
    delegate: Address;
    accountCode: Hex;
    accountNonce: number | bigint | undefined;
  },
): void {
  const current = delegatedTo(expected.accountCode);
  if (current !== undefined && !isAddressEqual(current, expected.delegate)) {
    throw catalogError(ERRORS.alchemyDelegatedElsewhere, {
      current,
      expected: expected.delegate,
    });
  }
  if (authorization === undefined) {
    if (current === undefined) {
      throw catalogError(ERRORS.alchemyNotDelegated, {});
    }
    return;
  }
  const chainId = readChainId(authorization.chainId, "authorization");
  const data = authorization.data;
  const address = addressOf(isObject(data) ? data.address : undefined);
  if (address === undefined) {
    throw catalogError(ERRORS.alchemyMalformed, { part: "authorization", field: "address" });
  }
  const nonce: unknown = isObject(data) ? data.nonce : undefined;
  if (!Number.isSafeInteger(nonce) || Number(nonce) < 0) {
    throw catalogError(ERRORS.alchemyMalformed, { part: "authorization", field: "nonce" });
  }
  if (chainId !== expected.chainId) {
    throw catalogError(ERRORS.alchemyChain, {
      part: "authorization",
      returned: chainId,
      expected: expected.chainId,
    });
  }
  if (!isAddressEqual(address, expected.delegate)) {
    throw catalogError(ERRORS.alchemyDelegate, { returned: address, expected: expected.delegate });
  }
  if (
    expected.accountNonce !== undefined &&
    BigInt(Number(nonce)) !== BigInt(expected.accountNonce)
  ) {
    throw catalogError(ERRORS.alchemyAuthNonce, {
      returned: Number(nonce),
      expected: expected.accountNonce,
    });
  }
}

/**
 * The delegate an account's code names: `undefined` for no code, the address for an EIP-7702
 * delegation. Other code is refused. The code is hex already.
 */
function delegatedTo(code: Hex): Address | undefined {
  if (code === "0x") {
    return undefined;
  }
  if (
    code.length !== DELEGATION_PREFIX.length + 40 ||
    !code.toLowerCase().startsWith(DELEGATION_PREFIX)
  ) {
    throw catalogError(ERRORS.alchemyAccountCode, {});
  }
  return `0x${code.slice(DELEGATION_PREFIX.length)}`;
}
