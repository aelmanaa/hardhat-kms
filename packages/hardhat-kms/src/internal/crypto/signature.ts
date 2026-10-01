import { secp256k1 } from "@noble/curves/secp256k1.js";

import { addressFromPublicKey } from "./address.ts";

/**
 * A signature as returned by a provider adapter, before normalization.
 *
 * - `der`: an ASN.1 DER `ECDSA-Sig-Value` (AWS KMS, GCP Cloud KMS).
 * - `compact`: 64 bytes `r || s` (Azure Key Vault, PKCS#11).
 * - `{ r, s, yParity }`: already split, as returned by API signers. `yParity` is ignored: the parity is always recovered against the known key.
 */
export type SignatureOutput =
  | { format: "der" | "compact"; bytes: Uint8Array }
  | { r: bigint; s: bigint; yParity?: 0 | 1 | undefined };

/** A normalized, recoverable secp256k1 signature. `s` is always in the lower half of the order. */
export interface RecoverableSignature {
  r: bigint;
  s: bigint;
  yParity: 0 | 1;
}

/** Error thrown when a signature cannot be parsed, is out of range, or does not match the key. */
export class InvalidSignatureError extends Error {
  public override readonly name = "InvalidSignatureError";
}

const CURVE_ORDER = secp256k1.Point.CURVE().n;
const HALF_CURVE_ORDER = CURVE_ORDER >> 1n;
const DIGEST_LENGTH = 32;
const COMPACT_LENGTH = 64;

/**
 * Parses a provider signature into `r` and `s`, strictly.
 *
 * DER input goes through noble's strict parser, which rejects trailing bytes, non-minimal
 * encodings and negative integers.
 *
 * @param output - The signature returned by the adapter.
 * @returns The raw `r` and `s`, not yet normalized.
 * @throws {InvalidSignatureError} If the encoding is invalid or a scalar is out of range.
 */
export function parseSignature(output: SignatureOutput): { r: bigint; s: bigint } {
  let r: bigint;
  let s: bigint;
  if ("format" in output) {
    // The adapter controls this value, and it ends up in error messages: allow only known formats.
    if (output.format !== "der" && output.format !== "compact") {
      throw new InvalidSignatureError("unsupported signature format; expected der or compact");
    }
    if (output.format === "compact" && output.bytes.length !== COMPACT_LENGTH) {
      throw new InvalidSignatureError(
        `expected a 64-byte compact signature, got ${output.bytes.length} bytes`,
      );
    }
    try {
      ({ r, s } = secp256k1.Signature.fromBytes(output.bytes, output.format));
    } catch {
      throw new InvalidSignatureError(`the ${output.format} signature could not be parsed`);
    }
  } else {
    ({ r, s } = output);
  }
  if (r <= 0n || r >= CURVE_ORDER || s <= 0n || s >= CURVE_ORDER) {
    throw new InvalidSignatureError("r or s is outside the range [1, n - 1]");
  }
  return { r, s };
}

/**
 * Normalizes `s` to the lower half of the curve order, as EIP-2 requires for transactions.
 *
 * @param s - The `s` scalar.
 * @returns `s` if it is already low, otherwise `n - s`.
 */
export function toLowS(s: bigint): bigint {
  return s > HALF_CURVE_ORDER ? CURVE_ORDER - s : s;
}

/**
 * Finds the recovery bit that makes `(r, s)` recover to `publicKey` for `digest`.
 *
 * Both parities are tried; if neither recovers the expected key the signature was made by a
 * different key (or the digest differs) and an error is thrown. The parity is never guessed.
 *
 * @param digest - The 32-byte digest that was signed.
 * @param r - The `r` scalar.
 * @param s - The low `s` scalar.
 * @param publicKey - The expected 65-byte uncompressed public key.
 * @returns The recovery bit.
 * @throws {InvalidSignatureError} If no parity recovers the expected key.
 */
export function recoverYParity(
  digest: Uint8Array,
  r: bigint,
  s: bigint,
  publicKey: Uint8Array,
): 0 | 1 {
  for (const yParity of [0, 1] as const) {
    const recovered = recoverPublicKey(digest, r, s, yParity);
    if (recovered !== undefined && equalBytes(recovered, publicKey)) {
      return yParity;
    }
  }
  throw new InvalidSignatureError("the signature does not recover to the expected public key");
}

/**
 * Recovers the public key that produced `(r, s)` over `digest` for one recovery bit.
 *
 * @param digest - The 32-byte digest that was signed.
 * @param r - The `r` scalar.
 * @param s - The `s` scalar.
 * @param yParity - The recovery bit to try.
 * @returns The 65-byte uncompressed public key, or `undefined` if this bit yields no valid point.
 * @throws {InvalidSignatureError} If the digest is not 32 bytes.
 */
export function recoverPublicKey(
  digest: Uint8Array,
  r: bigint,
  s: bigint,
  yParity: 0 | 1,
): Uint8Array | undefined {
  assertDigest(digest);
  try {
    return new secp256k1.Signature(r, s)
      .addRecoveryBit(yParity)
      .recoverPublicKey(digest)
      .toBytes(false);
  } catch {
    return undefined;
  }
}

/**
 * Turns a provider signature into a normalized recoverable signature for `publicKey`.
 *
 * Order: strict parse, range check, low-S normalization, trial recovery, final verification.
 *
 * @param output - The signature returned by the adapter.
 * @param digest - The 32-byte digest that was signed.
 * @param publicKey - The key the signature must belong to.
 * @returns The normalized signature with its recovery bit.
 * @throws {InvalidSignatureError} If any step fails.
 */
export function normalizeSignature(
  output: SignatureOutput,
  digest: Uint8Array,
  publicKey: Uint8Array,
): RecoverableSignature {
  const { r, s: rawS } = parseSignature(output);
  const s = toLowS(rawS);
  const yParity = recoverYParity(digest, r, s, publicKey);
  const compact = new secp256k1.Signature(r, s).toBytes("compact");
  if (!secp256k1.verify(compact, digest, publicKey, { prehash: false, lowS: true })) {
    throw new InvalidSignatureError(
      "the signature does not verify against the expected public key",
    );
  }
  return { r, s, yParity };
}

/**
 * Encodes a signature the way `eth_sign`, `personal_sign` and `eth_signTypedData_v4` return it.
 *
 * @param signature - The normalized signature.
 * @returns `0x`-prefixed hex of `r || s || v`, with `v` = 27 + yParity.
 */
export function toRpcSignature(signature: RecoverableSignature): string {
  const bytes = new Uint8Array(COMPACT_LENGTH + 1);
  bytes.set(new secp256k1.Signature(signature.r, signature.s).toBytes("compact"));
  bytes[COMPACT_LENGTH] = 27 + signature.yParity;
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

/** A 65-byte signature read by {@link parseRpcSignature}. */
export interface ParsedRpcSignature {
  /** The signature in low-S form, with the recovery bit that recovers the same key. */
  signature: RecoverableSignature;
  /** Whether the input was the high-S form, which `parseRpcSignature` folded to low S. */
  highS: boolean;
}

/**
 * Parses a 65-byte `r || s || v` signature, as `personal_sign`, `eth_signTypedData_v4` and
 * `kms sign` return it, the way alloy (and so `cast wallet verify`) reads one:
 *
 * - `v` is the bare recovery bit 0 or 1, 27 or 28, or an EIP-155 value of 35 or more, whose
 *   recovery bit is `(v - 35) % 2` (alloy's `normalize_v`);
 * - a high-S signature is folded to its low-S twin, with the other recovery bit, which recovers
 *   the same key (alloy's `normalized_s`). The caller learns of it through `highS`, since
 *   OpenZeppelin's `ECDSA.recover` rejects the high-S form.
 *
 * @param signature - `0x`-prefixed hex.
 * @returns The normalized signature, and whether it was high-S.
 * @throws {InvalidSignatureError} If the signature is not 65 bytes of hex, `r` or `s` is outside
 * [1, n - 1], or `v` is 2 to 26 or 29 to 34.
 */
export function parseRpcSignature(signature: string): ParsedRpcSignature {
  if (!/^0x[0-9a-fA-F]*$/.test(signature)) {
    throw new InvalidSignatureError("the signature must be 0x-prefixed hex");
  }
  const digits = signature.length - 2;
  if (digits !== (COMPACT_LENGTH + 1) * 2) {
    throw new InvalidSignatureError(
      `expected a 65-byte signature (r || s || v, 130 hex digits), got ${digits} hex digits`,
    );
  }
  const r = BigInt(`0x${signature.slice(2, 66)}`);
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = Number.parseInt(signature.slice(130), 16);
  if (r <= 0n || r >= CURVE_ORDER || s <= 0n || s >= CURVE_ORDER) {
    throw new InvalidSignatureError("r or s is outside the range [1, n - 1]");
  }
  const bit = recoveryBit(v);
  const highS = s > HALF_CURVE_ORDER;
  const yParity = highS ? (bit === 0 ? 1 : 0) : bit;
  return { signature: { r, s: toLowS(s), yParity }, highS };
}

/** The recovery bit a `v` value encodes, as alloy's `normalize_v` reads it. */
function recoveryBit(v: number): 0 | 1 {
  if (v === 0 || v === 27 || (v >= 35 && (v - 35) % 2 === 0)) {
    return 0;
  }
  if (v === 1 || v === 28 || v >= 35) {
    return 1;
  }
  throw new InvalidSignatureError(`v must be 0 or 1, 27 or 28, or 35 or more (EIP-155), got ${v}`);
}

/**
 * Recovers the address that signed `digest` from a signature and its recovery bit.
 *
 * @param digest - The 32-byte digest that was signed.
 * @param signature - The signature with its recovery bit.
 * @returns The signer's EIP-55 checksummed address.
 * @throws {InvalidSignatureError} If no public key recovers from the signature.
 */
export function recoverAddress(digest: Uint8Array, signature: RecoverableSignature): string {
  const publicKey = recoverPublicKey(digest, signature.r, signature.s, signature.yParity);
  if (publicKey === undefined) {
    throw new InvalidSignatureError("no public key recovers from the signature");
  }
  return addressFromPublicKey(publicKey);
}

function assertDigest(digest: Uint8Array): void {
  if (digest.length !== DIGEST_LENGTH) {
    throw new InvalidSignatureError(`expected a 32-byte digest, got ${digest.length} bytes`);
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
