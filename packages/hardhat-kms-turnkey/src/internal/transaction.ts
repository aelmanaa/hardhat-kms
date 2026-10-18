import type { Problem, RawSignature } from "./activity.ts";
import { decodeRlp, rlpInteger, type RlpItem } from "./rlp.ts";

/*
 * Reads the signature out of the signed transaction Turnkey's `sign_transaction` returns, after
 * checking that Turnkey signed the transaction the plugin sent.
 *
 * The core gives the adapter its unsigned serialized transaction: for types 1, 2 and 4 the EIP-2718
 * type byte, then the RLP list of the type's fields (EIP-2930, EIP-1559, EIP-7702); for a legacy
 * transaction the EIP-155 list `[nonce, gasPrice, gas, to, value, data, chainId, 0, 0]`. Turnkey
 * returns the same transaction with the signature: the typed list with `yParity, r, s` appended,
 * or the legacy list with `chainId, 0, 0` replaced by `v, r, s`, where `v` is
 * `chainId * 2 + 35 + yParity` (EIP-155). `@turnkey/viem` 0.14.46 and `@turnkey/ethers` 1.3.46 pass
 * this result to `parseTransaction` and `Transaction.from`, which read exactly these forms.
 *
 * The plugin uses only `r`, `s` and the parity. The core then verifies them against its own
 * digest and broadcasts its own transaction, never Turnkey's bytes. Checking the fields here as
 * well names what differs, and refuses an answer for another transaction even when its signature
 * would not verify anyway.
 */

/** The field names of each type, in the order of its unsigned RLP list. Legacy: before `chainId`. */
const FIELDS = {
  0: ["nonce", "gasPrice", "gas", "to", "value", "data"],
  1: ["chainId", "nonce", "gasPrice", "gas", "to", "value", "data", "accessList"],
  2: [
    "chainId",
    "nonce",
    "maxPriorityFeePerGas",
    "maxFeePerGas",
    "gas",
    "to",
    "value",
    "data",
    "accessList",
  ],
  4: [
    "chainId",
    "nonce",
    "maxPriorityFeePerGas",
    "maxFeePerGas",
    "gas",
    "to",
    "value",
    "data",
    "accessList",
    "authorizationList",
  ],
} as const;

/** A transaction type the adapter sends to `sign_transaction`. Blob transactions (3) are not. */
type TransactionType = keyof typeof FIELDS;

/** The core's unsigned transaction, read: its type, chain id and unsigned fields. */
export interface UnsignedTransaction {
  type: TransactionType;
  chainId: bigint;
  /** The fields Turnkey's answer must repeat. For a legacy transaction, those before `chainId`. */
  fields: readonly RlpItem[];
}

/** The typed transactions the adapter sends, by their type byte. */
const TYPED: ReadonlyMap<number, Exclude<TransactionType, 0>> = new Map([
  [1, 1],
  [2, 2],
  [4, 4],
]);

/** A list item of `items.length` fields, or `undefined`. */
function listOf(item: RlpItem | undefined, length: number): RlpItem[] | undefined {
  return item?.kind === "list" && item.items.length === length ? item.items : undefined;
}

/** Whether an item is the RLP empty string, the encoding of 0. */
function isEmpty(item: RlpItem | undefined): boolean {
  return item?.kind === "bytes" && item.value.length === 0;
}

/**
 * Reads the core's unsigned transaction.
 *
 * @param unsigned - The core's unsigned serialized transaction.
 * @param requested - The EIP-2718 type the core named, 0 for legacy.
 * @param chainId - The chain id the core named.
 * @returns The transaction, or `undefined` when its type is not 0, 1, 2 or 4, or its bytes are
 * not that type's unsigned form for this chain id.
 */
export function readUnsigned(
  unsigned: Uint8Array,
  requested: number,
  chainId: bigint,
): UnsignedTransaction | undefined {
  // EIP-155 and the typed transactions need a positive chain id; the core always sets one.
  if (chainId <= 0n) {
    return undefined;
  }
  if (requested === 0) {
    const items = listOf(decodeRlp(unsigned), FIELDS[0].length + 3);
    if (
      items === undefined ||
      rlpInteger(items[6], 32) !== chainId ||
      !isEmpty(items[7]) ||
      !isEmpty(items[8])
    ) {
      return undefined;
    }
    return { type: 0, chainId, fields: items.slice(0, FIELDS[0].length) };
  }
  if (unsigned[0] !== requested) {
    return undefined;
  }
  const type = TYPED.get(requested);
  if (type === undefined) {
    return undefined;
  }
  const items = listOf(decodeRlp(unsigned.subarray(1)), FIELDS[type].length);
  if (items === undefined || rlpInteger(items[0], 32) !== chainId) {
    return undefined;
  }
  return { type, chainId, fields: items };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Checks Turnkey's signed transaction against the unsigned one and reads its signature.
 *
 * @param signed - The signed transaction Turnkey returned.
 * @param expected - The core's unsigned transaction.
 * @returns `r`, `s` and the parity, or what is wrong with the answer: `malformed` when it is not
 * a signed transaction of the type's form, `transaction-mismatch` with the first field that differs.
 */
export function signatureOfSignedTransaction(
  signed: Uint8Array,
  expected: UnsignedTransaction,
): RawSignature | Problem {
  const legacy = expected.type === 0;
  const first = signed[0];
  // A legacy transaction starts with its list prefix, at least 0xc0; a typed one with its type.
  if (first === undefined || (legacy ? first < 0xc0 : first !== expected.type)) {
    return { kind: "transaction-mismatch", field: "type" };
  }
  const names = FIELDS[expected.type];
  const decoded = decodeRlp(legacy ? signed : signed.subarray(1));
  if (decoded?.kind !== "list") {
    return { kind: "malformed", problem: "the signed transaction is not one canonical RLP list" };
  }
  const items = listOf(decoded, names.length + 3);
  if (items === undefined) {
    return {
      kind: "malformed",
      problem: "the signed transaction does not have the fields of its type and a signature",
    };
  }
  for (const [index, name] of names.entries()) {
    const ours = expected.fields[index];
    const theirs = items[index];
    if (ours === undefined || theirs === undefined || !sameBytes(ours.encoded, theirs.encoded)) {
      return { kind: "transaction-mismatch", field: name };
    }
  }
  const [v, r, s] = items.slice(names.length);
  const rValue = rlpInteger(r, 32);
  const sValue = rlpInteger(s, 32);
  if (rValue === undefined || rValue === 0n) {
    return { kind: "malformed", problem: "r is not a canonical integer of 1 to 32 bytes" };
  }
  if (sValue === undefined || sValue === 0n) {
    return { kind: "malformed", problem: "s is not a canonical integer of 1 to 32 bytes" };
  }
  if (legacy) {
    const vValue = rlpInteger(v, 32);
    if (vValue === undefined) {
      return { kind: "malformed", problem: "v is not a canonical integer of at most 32 bytes" };
    }
    // EIP-155: v = chainId * 2 + 35 + yParity. Any other v signs for another chain, or none.
    const parity = vValue - expected.chainId * 2n - 35n;
    if (parity !== 0n && parity !== 1n) {
      return { kind: "transaction-mismatch", field: "chainId" };
    }
    return { r: rValue, s: sValue, yParity: parity === 0n ? 0 : 1 };
  }
  const yParity = rlpInteger(v, 1);
  if (yParity !== 0n && yParity !== 1n) {
    return { kind: "malformed", problem: "yParity is not 0 or 1" };
  }
  return { r: rValue, s: sValue, yParity: yParity === 0n ? 0 : 1 };
}
