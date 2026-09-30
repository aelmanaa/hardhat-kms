import { secp256k1 } from "@noble/curves/secp256k1.js";

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

function assertDigest(digest: Uint8Array): void {
  if (digest.length !== DIGEST_LENGTH) {
    throw new InvalidSignatureError(`expected a 32-byte digest, got ${digest.length} bytes`);
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
