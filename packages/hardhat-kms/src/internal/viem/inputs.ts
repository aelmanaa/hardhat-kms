// Reads what viem passes to a library account, and refuses anything the account does not sign,
// before any KMS call. Nothing here imports viem.
import { isObject } from "@nomicfoundation/hardhat-utils/lang";
import { addr, Transaction } from "micro-eth-signer";

import { toChecksumAddress } from "../crypto/address.ts";
import type { TypedData } from "../crypto/digests.ts";
import { ERRORS } from "../error-catalog.ts";
import { catalogError } from "../errors.ts";
import type { UnsignedTransaction } from "../rpc/transaction-filler.ts";
import { readTypedData } from "../rpc/typed-data.ts";
import type { KmsHex } from "./types.ts";

/** The transaction types a library account signs, by viem's names. */
const SIGNED_TYPES = ["legacy", "eip2930", "eip1559", "eip7702"] as const;
type SignedType = (typeof SIGNED_TYPES)[number];

/** The fields that make a transaction a blob transaction (EIP-4844), as viem tells its type. */
const BLOB_FIELDS = ["blobs", "blobVersionedHashes", "maxFeePerBlobGas", "sidecars"];

const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;

/** The signed types by name, to look a requested `type` up. */
const SIGNED_TYPE_NAMES = new Map<unknown, SignedType>(SIGNED_TYPES.map((type) => [type, type]));

/**
 * Refuses a field the account cannot read.
 *
 * @param operation - The account method, for the error message.
 * @param field - The field's path, such as `transaction.nonce`.
 * @param expected - What the field must be.
 * @returns The error to throw.
 */
function invalidField(operation: string, field: string, expected: string): Error {
  return catalogError(ERRORS.accountField, { field, expected }, { operation });
}

/**
 * Reads a non-negative integer given as a number or a bigint, as viem takes quantities.
 *
 * @returns The value, or `undefined` when the field is absent.
 */
function readQuantity(value: unknown, field: string, operation: string): bigint | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "bigint" && value >= 0n) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw invalidField(operation, field, "a non-negative integer, as a number or a bigint");
}

/** Reads `0x`-prefixed hex bytes. */
function readHex(value: unknown, field: string, operation: string): string {
  if (typeof value === "string" && HEX_BYTES.test(value)) {
    return value.toLowerCase();
  }
  throw invalidField(operation, field, "0x-prefixed hex bytes");
}

/**
 * Reads an address, checksummed.
 *
 * @param value - The value.
 * @param field - The field's path, for the error message.
 * @param operation - The account method, for the error message.
 * @returns The checksummed address.
 */
export function readAddress(value: unknown, field: string, operation: string): KmsHex {
  if (typeof value === "string") {
    try {
      return `0x${toChecksumAddress(value).slice(2)}`;
    } catch {
      // toChecksumAddress throws only InvalidAddressError; the error below says what is expected.
    }
  }
  throw invalidField(
    operation,
    field,
    "an address: 0x and 40 hex digits, with a valid EIP-55 checksum if it is mixed-case",
  );
}

/**
 * Reads the message of `signMessage`: UTF-8 text, or bytes as hex or a `Uint8Array`, as viem's
 * `SignableMessage`.
 *
 * @param parameters - `signMessage`'s parameter.
 * @param operation - The account method, for error messages.
 * @returns A private copy of the message bytes.
 */
export function readMessage(parameters: unknown, operation: string): Uint8Array {
  const message: unknown = isObject(parameters) ? parameters.message : undefined;
  if (typeof message === "string") {
    return new Uint8Array(Buffer.from(message, "utf8"));
  }
  const raw: unknown = isObject(message) ? message.raw : undefined;
  if (raw instanceof Uint8Array) {
    return new Uint8Array(raw);
  }
  if (typeof raw === "string" && HEX_BYTES.test(raw)) {
    return new Uint8Array(Buffer.from(raw.slice(2), "hex"));
  }
  throw invalidField(
    operation,
    "message",
    "a string, or { raw } with 0x-prefixed hex bytes or a Uint8Array",
  );
}

/**
 * Reads the 32-byte digest of `sign({ hash })`.
 *
 * @param parameters - `sign`'s parameter.
 * @param operation - The account method, for error messages.
 * @returns The digest.
 */
export function readHash(parameters: unknown, operation: string): Uint8Array {
  const hash: unknown = isObject(parameters) ? parameters.hash : undefined;
  if (typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash)) {
    return new Uint8Array(Buffer.from(hash.slice(2), "hex"));
  }
  throw invalidField(operation, "hash", "32 bytes as 0x-prefixed hex");
}

/**
 * Reads the typed data of `signTypedData`, in viem's form: `types` may leave out `EIP712Domain`,
 * and `domain` may be absent.
 *
 * @param parameters - `signTypedData`'s parameter.
 * @param operation - The account method, for error messages.
 * @returns A private, checked copy of the typed data.
 */
export function readViemTypedData(parameters: unknown, operation: string): TypedData {
  if (!isObject(parameters)) {
    throw invalidField(operation, "typed data", "an object with types, primaryType and message");
  }
  if (parameters.primaryType === "EIP712Domain") {
    // viem signs the domain separator alone for it, which the EIP-712 encoder does not do.
    throw invalidField(operation, "primaryType", "a type of `types`, not EIP712Domain");
  }
  return readTypedData(
    {
      types: parameters.types,
      primaryType: parameters.primaryType,
      domain: parameters.domain ?? {},
      message: parameters.message,
    },
    operation,
  );
}

/** An EIP-7702 authorization to sign, read from viem's `AuthorizationRequest`. */
export interface AuthorizationInput {
  /** The delegate as the caller gave it, which viem returns unchanged. */
  delegate: KmsHex;
  /** The delegate's 20 bytes. */
  delegateBytes: Uint8Array;
  /** The chain, a safe integer as viem types it. */
  chainId: number;
  /** The authority's nonce, a safe integer as viem types it, so below EIP-7702's 2^64 - 1. */
  nonce: number;
}

/** Reads a non-negative safe integer, as viem types an authorization's chain id and nonce. */
function readSafeInteger(value: unknown, field: string, operation: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw invalidField(operation, field, "a non-negative integer, as a number");
}

/**
 * Reads the parameter of `signAuthorization`: `address` or `contractAddress`, `chainId` and
 * `nonce`.
 *
 * @param parameters - `signAuthorization`'s parameter.
 * @param operation - The account method, for error messages.
 * @returns The authorization.
 */
export function readAuthorization(parameters: unknown, operation: string): AuthorizationInput {
  if (!isObject(parameters)) {
    throw invalidField(operation, "authorization", "an object with address, chainId and nonce");
  }
  const delegate: unknown = parameters.contractAddress ?? parameters.address;
  const checksummed = readAddress(delegate, "address", operation);
  return {
    delegate: typeof delegate === "string" ? `0x${delegate.slice(2)}` : checksummed,
    delegateBytes: new Uint8Array(Buffer.from(checksummed.slice(2), "hex")),
    chainId: readSafeInteger(parameters.chainId, "chainId", operation),
    nonce: readSafeInteger(parameters.nonce, "nonce", operation),
  };
}

/** A transaction read from viem's `TransactionSerializable`, ready to sign. */
export interface TransactionInput {
  /** Its type, by viem's name. */
  type: SignedType;
  chainId: bigint;
  /** The unsigned transaction, built with the plugin's serializer. */
  unsigned: UnsignedTransaction;
}

/**
 * Tells a transaction's type the way viem's `getTransactionType` does, and refuses blob
 * transactions and types the account does not sign.
 */
function transactionType(tx: Record<string, unknown>, operation: string): SignedType {
  const { type } = tx;
  if (type === "eip4844" || BLOB_FIELDS.some((field) => tx[field] !== undefined)) {
    throw catalogError(ERRORS.txBlob, {}, { operation });
  }
  if (type !== undefined) {
    const signed = SIGNED_TYPE_NAMES.get(type);
    if (signed !== undefined) {
      return signed;
    }
    throw catalogError(
      ERRORS.accountTxType,
      { type: typeof type === "string" ? type.slice(0, 32) : typeof type },
      { operation },
    );
  }
  if (tx.authorizationList !== undefined) {
    return "eip7702";
  }
  if (tx.maxFeePerGas !== undefined || tx.maxPriorityFeePerGas !== undefined) {
    return "eip1559";
  }
  if (tx.gasPrice !== undefined) {
    return tx.accessList === undefined ? "legacy" : "eip2930";
  }
  throw catalogError(ERRORS.accountTxNoType, {}, { operation });
}

function readAccessList(
  value: unknown,
  operation: string,
): { address: string; storageKeys: string[] }[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw invalidField(operation, "transaction.accessList", "an array");
  }
  return value.map((entry: unknown, index) => {
    const field = `transaction.accessList[${index}]`;
    if (!isObject(entry) || !Array.isArray(entry.storageKeys)) {
      throw invalidField(operation, field, "an object with address and storageKeys");
    }
    return {
      address: readAddress(entry.address, `${field}.address`, operation),
      storageKeys: entry.storageKeys.map((key: unknown, keyIndex) => {
        const hex = readHex(key, `${field}.storageKeys[${keyIndex}]`, operation);
        if (hex.length !== 66) {
          throw invalidField(operation, `${field}.storageKeys[${keyIndex}]`, "32 bytes of hex");
        }
        return hex;
      }),
    };
  });
}

/** The recovery bit of a signed authorization, from `yParity`, or else from `v` as viem reads it. */
function authorizationYParity(entry: Record<string, unknown>, field: string, operation: string) {
  const { yParity, v } = entry;
  if (yParity === 0 || yParity === 1) {
    return yParity;
  }
  if (yParity === undefined && (v === 0n || v === 27n)) {
    return 0;
  }
  if (yParity === undefined && (v === 1n || v === 28n)) {
    return 1;
  }
  throw invalidField(operation, `${field}.yParity`, "0 or 1, or v as 27n or 28n");
}

function readAuthorizationList(
  value: unknown,
  operation: string,
): {
  chainId: bigint;
  address: string;
  nonce: bigint;
  yParity: number;
  r: bigint;
  s: bigint;
}[] {
  if (!Array.isArray(value)) {
    throw invalidField(operation, "transaction.authorizationList", "an array");
  }
  return value.map((entry: unknown, index) => {
    const field = `transaction.authorizationList[${index}]`;
    if (!isObject(entry)) {
      throw invalidField(operation, field, "a signed authorization");
    }
    const scalar = (name: "r" | "s"): bigint => {
      const hex = readHex(entry[name], `${field}.${name}`, operation);
      if (hex.length > 66) {
        throw invalidField(operation, `${field}.${name}`, "at most 32 bytes of hex");
      }
      return BigInt(hex === "0x" ? 0 : hex);
    };
    return {
      chainId: readQuantity(entry.chainId, `${field}.chainId`, operation) ?? 0n,
      address: readAddress(entry.address, `${field}.address`, operation),
      nonce: readQuantity(entry.nonce, `${field}.nonce`, operation) ?? 0n,
      yParity: authorizationYParity(entry, field, operation),
      r: scalar("r"),
      s: scalar("s"),
    };
  });
}

/** The fields every transaction type has, in micro-eth-signer's names. */
interface BaseFields {
  to: string;
  nonce: bigint;
  chainId: bigint;
  value: bigint;
  data: string;
  gasLimit: bigint;
}

/** The fields that only some types have; each type takes its own. */
interface TypeFields {
  gasPrice: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  accessList: { address: string; storageKeys: string[] }[];
  authorizationList: ReturnType<typeof readAuthorizationList>;
}

/** Builds the unsigned transaction with micro-eth-signer, with strict mode off as Hardhat does. */
function prepare(type: SignedType, base: BaseFields, fields: TypeFields): UnsignedTransaction {
  const strict = false;
  const { gasPrice, maxFeePerGas, maxPriorityFeePerGas, accessList, authorizationList } = fields;
  if (type === "legacy") {
    return Transaction.prepare({ type, ...base, gasPrice }, strict);
  }
  if (type === "eip2930") {
    return Transaction.prepare({ type, ...base, gasPrice, accessList }, strict);
  }
  const fees = { ...base, maxFeePerGas, maxPriorityFeePerGas, accessList };
  return type === "eip1559"
    ? Transaction.prepare({ type, ...fees }, strict)
    : Transaction.prepare({ type, ...fees, authorizationList }, strict);
}

/**
 * Reads a transaction in viem's `TransactionSerializable` fields and builds it with the plugin's
 * serializer (micro-eth-signer, as Hardhat's local accounts). Absent quantities are 0, as viem
 * serializes them. Every refusal here happens before any KMS call.
 *
 * @param transaction - `signTransaction`'s first parameter.
 * @param operation - The account method, for error messages.
 * @returns The transaction's type, chain and unsigned form.
 */
export function readTransaction(transaction: unknown, operation: string): TransactionInput {
  if (!isObject(transaction)) {
    throw catalogError(ERRORS.txNotObject, {}, { operation });
  }
  const type = transactionType(transaction, operation);
  const chainId = readQuantity(transaction.chainId, "transaction.chainId", operation);
  if (chainId === undefined) {
    throw catalogError(ERRORS.accountTxNoChain, {}, { operation });
  }
  const quantity = (name: string): bigint =>
    readQuantity(transaction[name], `transaction.${name}`, operation) ?? 0n;
  const { to, data } = transaction;
  if ((to === undefined || to === null) && data === undefined) {
    throw catalogError(ERRORS.txCreationNoData, {}, { operation });
  }
  const base = {
    to:
      to === undefined || to === null
        ? addr.addChecksum("0x", true)
        : readAddress(to, "transaction.to", operation),
    nonce: quantity("nonce"),
    chainId,
    value: quantity("value"),
    data: data === undefined ? "0x" : readHex(data, "transaction.data", operation),
    gasLimit: quantity("gas"),
  };
  const accessList =
    type === "legacy" ? undefined : readAccessList(transaction.accessList, operation);
  const authorizationList =
    type === "eip7702"
      ? readAuthorizationList(transaction.authorizationList, operation)
      : undefined;
  let unsigned: UnsignedTransaction;
  try {
    unsigned = prepare(type, base, {
      gasPrice: quantity("gasPrice"),
      maxFeePerGas: quantity("maxFeePerGas"),
      maxPriorityFeePerGas: quantity("maxPriorityFeePerGas"),
      accessList: accessList ?? [],
      authorizationList: authorizationList ?? [],
    });
  } catch (error) {
    // micro-eth-signer's own message about the caller's values: safe to show.
    throw catalogError(
      ERRORS.accountTxInvalid,
      { reason: error instanceof Error ? error.message.slice(0, 200) : String(error) },
      { operation },
    );
  }
  return { type, chainId, unsigned };
}
