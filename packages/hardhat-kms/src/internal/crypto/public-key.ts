import { createPublicKey, type KeyObject } from "node:crypto";

import { secp256k1 } from "@noble/curves/secp256k1.js";

import { ERRORS } from "../error-catalog.ts";
import { catalogMessage } from "../errors.ts";

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
  const publicKey = publicKeyFromKeyObject(() =>
    createPublicKey({ key: Buffer.from(der), format: "der", type: "spki" }),
  );
  // Node also accepts trailing bytes and compressed points; require the one canonical encoding,
  // as the signature parser does for signatures.
  const canonical = Uint8Array.from([...SECP256K1_SPKI_PREFIX, ...publicKey]);
  // Without the length check, a longer der still fails every() at its first extra byte, and a
  // shorter one would be a truncated prefix of the canonical encoding, which Node cannot read.
  if (
    // Stryker disable next-line ConditionalExpression: every() alone refuses any der Node could read
    der.length !== canonical.length ||
    !der.every((byte, index) => byte === canonical[index])
  ) {
    throw new InvalidPublicKeyError(catalogMessage(ERRORS.spkiDer, {}));
  }
  return publicKey;
}

/** The DER prefix of an uncompressed secp256k1 SubjectPublicKeyInfo, before the 65-byte point. */
const SECP256K1_SPKI_PREFIX = Uint8Array.from(
  Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex"),
);

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
  // Stryker disable next-line ConditionalExpression: the set refuses undefined with the same error
  if (jwk.kty === undefined || !JWK_KEY_TYPES.has(jwk.kty)) {
    throw new InvalidPublicKeyError(
      catalogMessage(ERRORS.jwkKeyType, { keyType: String(jwk.kty) }),
    );
  }
  // Stryker disable next-line ConditionalExpression: the set refuses undefined with the same error
  if (jwk.crv === undefined || !JWK_SECP256K1_CURVES.has(jwk.crv)) {
    throw new InvalidPublicKeyError(catalogMessage(ERRORS.jwkCurve, { curve: String(jwk.crv) }));
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
    throw new InvalidPublicKeyError(catalogMessage(ERRORS.publicKeyLength, {}));
  }
  try {
    secp256k1.Point.fromBytes(publicKey).assertValidity();
  } catch {
    throw new InvalidPublicKeyError(catalogMessage(ERRORS.notOnCurve, {}));
  }
  return publicKey;
}

function publicKeyFromKeyObject(load: () => KeyObject): Uint8Array {
  let key: KeyObject;
  try {
    key = load();
  } catch {
    throw new InvalidPublicKeyError(catalogMessage(ERRORS.spkiParse, {}));
  }
  // A key that is not EC fails the curve check too, with the same error. Node returns an object
  // from asymmetricKeyDetails for every key it loads, {} when it has no details for the type.
  if (
    // Stryker disable next-line ConditionalExpression: the curve check refuses non-EC keys too
    key.asymmetricKeyType !== "ec" ||
    // Stryker disable next-line OptionalChaining: Node never returns undefined details
    key.asymmetricKeyDetails?.namedCurve !== "secp256k1"
  ) {
    throw new InvalidPublicKeyError(
      catalogMessage(ERRORS.spkiCurve, {
        keyType: String(key.asymmetricKeyType),
        // Stryker disable next-line OptionalChaining: Node never returns undefined details
        curve: String(key.asymmetricKeyDetails?.namedCurve),
      }),
    );
  }
  const jwk = key.export({ format: "jwk" });
  return publicKeyFromJwk({ kty: "EC", crv: "secp256k1", x: jwk.x, y: jwk.y });
}

function coordinateBytes(value: Uint8Array | string | undefined, name: string): Uint8Array {
  if (value === undefined) {
    throw new InvalidPublicKeyError(
      catalogMessage(ERRORS.jwkCoordinateMissing, { coordinate: name }),
    );
  }
  // Stryker disable next-line ConditionalExpression: Buffer.from(bytes, encoding) copies the bytes
  return typeof value === "string" ? new Uint8Array(Buffer.from(value, "base64url")) : value;
}

function leftPad(bytes: Uint8Array, name: string): Uint8Array {
  if (bytes.length > COORDINATE_LENGTH) {
    throw new InvalidPublicKeyError(catalogMessage(ERRORS.jwkCoordinateLong, { coordinate: name }));
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
