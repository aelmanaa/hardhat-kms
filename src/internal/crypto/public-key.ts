import { createPublicKey, type KeyObject } from "node:crypto";

import { secp256k1 } from "@noble/curves/secp256k1.js";

/** Length in bytes of an uncompressed secp256k1 public key: `0x04 || x || y`. */
const UNCOMPRESSED_PUBLIC_KEY_LENGTH = 65;

const COORDINATE_LENGTH = 32;

/**
 * Error thrown when a provider returns a public key that is not a usable secp256k1 key.
 */
export class InvalidPublicKeyError extends Error {
  public override readonly name = "InvalidPublicKeyError";
}

/**
 * Parses a DER-encoded SubjectPublicKeyInfo (as returned by AWS KMS `GetPublicKey`).
 *
 * @param der - The SPKI structure, DER encoded.
 * @returns The 65-byte uncompressed public key.
 * @throws {InvalidPublicKeyError} If the key is not a valid secp256k1 key.
 */
export function publicKeyFromSpkiDer(der: Uint8Array): Uint8Array {
  return publicKeyFromKeyObject(() =>
    createPublicKey({ key: Buffer.from(der), format: "der", type: "spki" }),
  );
}

/**
 * Parses a PEM-encoded SubjectPublicKeyInfo (as returned by GCP Cloud KMS `getPublicKey`).
 *
 * @param pem - The SPKI structure, PEM encoded.
 * @returns The 65-byte uncompressed public key.
 * @throws {InvalidPublicKeyError} If the key is not a valid secp256k1 key.
 */
export function publicKeyFromSpkiPem(pem: string): Uint8Array {
  return publicKeyFromKeyObject(() => createPublicKey({ key: pem, format: "pem" }));
}

/** The JSON Web Key fields that describe an elliptic-curve public key. */
export interface EcJsonWebKey {
  /** Key type. Azure Key Vault uses `EC`, Managed HSM and HSM-backed vault keys use `EC-HSM`. */
  kty?: string | undefined;
  /** Curve name. Azure uses `P-256K` for secp256k1. */
  crv?: string | undefined;
  /** X coordinate, big-endian. Azure may omit leading zero bytes. */
  x?: Uint8Array | string | undefined;
  /** Y coordinate, big-endian. Azure may omit leading zero bytes. */
  y?: Uint8Array | string | undefined;
}

const JWK_KEY_TYPES = new Set(["EC", "EC-HSM"]);
const JWK_SECP256K1_CURVES = new Set(["P-256K", "SECP256K1", "secp256k1"]);

/**
 * Builds the uncompressed public key from a JSON Web Key (as returned by Azure Key Vault).
 *
 * Coordinates may be raw bytes or base64url strings, and may be shorter than 32 bytes when
 * the service strips leading zeros; they are left-padded before use.
 *
 * @param jwk - The JSON Web Key.
 * @returns The 65-byte uncompressed public key.
 * @throws {InvalidPublicKeyError} If the key type or curve is wrong, or the point is not on the curve.
 */
export function publicKeyFromJwk(jwk: EcJsonWebKey): Uint8Array {
  if (jwk.kty === undefined || !JWK_KEY_TYPES.has(jwk.kty)) {
    throw new InvalidPublicKeyError(`expected an EC key, got key type "${String(jwk.kty)}"`);
  }
  if (jwk.crv === undefined || !JWK_SECP256K1_CURVES.has(jwk.crv)) {
    throw new InvalidPublicKeyError(`expected curve P-256K (secp256k1), got "${String(jwk.crv)}"`);
  }
  const x = leftPad(coordinateBytes(jwk.x, "x"), "x");
  const y = leftPad(coordinateBytes(jwk.y, "y"), "y");
  return assertOnCurve(concat([Uint8Array.of(0x04), x, y]));
}

/**
 * Checks that `publicKey` is a 65-byte uncompressed secp256k1 point that lies on the curve.
 *
 * @param publicKey - The candidate public key.
 * @returns The same bytes, for chaining.
 * @throws {InvalidPublicKeyError} If the length, prefix or point is invalid.
 */
export function assertOnCurve(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== UNCOMPRESSED_PUBLIC_KEY_LENGTH || publicKey[0] !== 0x04) {
    throw new InvalidPublicKeyError("expected a 65-byte uncompressed public key");
  }
  try {
    secp256k1.Point.fromBytes(publicKey).assertValidity();
  } catch {
    throw new InvalidPublicKeyError("the public key is not a point on secp256k1");
  }
  return publicKey;
}

function publicKeyFromKeyObject(load: () => KeyObject): Uint8Array {
  let key: KeyObject;
  try {
    key = load();
  } catch {
    throw new InvalidPublicKeyError("the public key could not be parsed as SubjectPublicKeyInfo");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "secp256k1") {
    throw new InvalidPublicKeyError(
      `expected a secp256k1 key, got ${String(key.asymmetricKeyType)} ${String(key.asymmetricKeyDetails?.namedCurve)}`,
    );
  }
  const jwk = key.export({ format: "jwk" });
  return publicKeyFromJwk({ kty: "EC", crv: "secp256k1", x: jwk.x, y: jwk.y });
}

function coordinateBytes(value: Uint8Array | string | undefined, name: string): Uint8Array {
  if (value === undefined) {
    throw new InvalidPublicKeyError(`the key has no "${name}" coordinate`);
  }
  return typeof value === "string" ? new Uint8Array(Buffer.from(value, "base64url")) : value;
}

function leftPad(bytes: Uint8Array, name: string): Uint8Array {
  if (bytes.length > COORDINATE_LENGTH) {
    throw new InvalidPublicKeyError(`the "${name}" coordinate is longer than 32 bytes`);
  }
  const padded = new Uint8Array(COORDINATE_LENGTH);
  padded.set(bytes, COORDINATE_LENGTH - bytes.length);
  return padded;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
