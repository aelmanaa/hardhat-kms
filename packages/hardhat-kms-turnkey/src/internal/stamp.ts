import {
  createECDH,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";

/*
 * Turnkey's API key stamp, on node:crypto alone. Turnkey's docs ("Stamps",
 * https://docs.turnkey.com/api-reference/overview/stamps) and its Node stamper
 * (`@turnkey/api-key-stamper` 0.6.18, `dist/index.mjs` and `dist/nodecrypto.mjs`) define it:
 *
 * - The API key is a P-256 key pair: the private key a 32-byte scalar in hex, the public key the
 *   33-byte compressed point in hex.
 * - The signature is ECDSA P-256 over SHA-256 of the exact JSON body, DER-encoded, in hex.
 *   `crypto.createSign("SHA256")` makes it there, so stamps are not deterministic.
 * - The `X-Stamp` header is base64url of the JSON `{ publicKey, scheme, signature }`, with the
 *   scheme `SIGNATURE_SCHEME_TK_API_P256`.
 *
 * test/unit/stamp.test.ts checks that each side's stamp verifies with the other's verifier.
 */

/** The header that carries the stamp. */
export const STAMP_HEADER = "X-Stamp";

/** Turnkey's scheme name for a P-256 API key. */
export const STAMP_SCHEME = "SIGNATURE_SCHEME_TK_API_P256";

/** A P-256 private key in hex, as Turnkey writes it: 32 bytes. */
const PRIVATE_KEY_HEX = /^[0-9a-fA-F]{64}$/;

/** A Turnkey API key, ready to stamp requests. Never print or log it. */
export interface ApiKey {
  /** The compressed public key, 66 lowercase hex characters. */
  readonly publicKey: string;
  /** The private key, for `crypto.sign`. */
  readonly privateKey: KeyObject;
}

/** The parsed content of an `X-Stamp` header. */
export interface Stamp {
  publicKey: string;
  scheme: string;
  signature: string;
}

/**
 * Builds an API key from its private key's hex. The public key is derived from it, as Foundry and
 * alloy derive it (`TurnkeyP256ApiKey::from_strings(key, None)`).
 *
 * @param privateKeyHex - The private key: 64 hex characters.
 * @returns The key, or `undefined` when the value is not a P-256 private key. The caller reports
 * that without the value.
 */
export function apiKeyFromPrivateKey(privateKeyHex: string): ApiKey | undefined {
  if (!PRIVATE_KEY_HEX.test(privateKeyHex)) {
    return undefined;
  }
  const scalar = Buffer.from(privateKeyHex, "hex");
  const ecdh = createECDH("prime256v1");
  try {
    // Refuses 0 and any value at or above the curve order.
    ecdh.setPrivateKey(scalar);
  } catch {
    return undefined;
  }
  const point = ecdh.getPublicKey();
  const privateKey = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33, 65).toString("base64url"),
      d: scalar.toString("base64url"),
    },
    format: "jwk",
  });
  return { publicKey: ecdh.getPublicKey("hex", "compressed"), privateKey };
}

/**
 * Whether a configured API public key names the same key as the derived one. Turnkey writes it as
 * a compressed point; the case of the hex does not matter.
 *
 * @param configured - The configured public key, trimmed.
 * @param derived - The public key derived from the private key.
 * @returns Whether they are the same key.
 */
export function samePublicKey(configured: string, derived: string): boolean {
  return configured.toLowerCase() === derived;
}

/**
 * Stamps a request body: signs it with the API key and returns the `X-Stamp` header's value.
 *
 * @param body - The exact JSON body the request sends.
 * @param apiKey - The API key.
 * @returns The header value, base64url of the stamp JSON.
 */
export function stampBody(body: string, apiKey: ApiKey): string {
  const signature = sign("sha256", Buffer.from(body), {
    key: apiKey.privateKey,
    dsaEncoding: "der",
  });
  const stamp: Stamp = {
    publicKey: apiKey.publicKey,
    scheme: STAMP_SCHEME,
    signature: signature.toString("hex"),
  };
  return Buffer.from(JSON.stringify(stamp)).toString("base64url");
}

/**
 * Reads an `X-Stamp` header value.
 *
 * @param header - The header value.
 * @returns The stamp, or `undefined` when it is not base64url of a stamp's JSON.
 */
export function parseStamp(header: string): Stamp | undefined {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const publicKey: unknown = Reflect.get(value, "publicKey");
  const scheme: unknown = Reflect.get(value, "scheme");
  const signature: unknown = Reflect.get(value, "signature");
  return typeof publicKey === "string" &&
    typeof scheme === "string" &&
    typeof signature === "string"
    ? { publicKey, scheme, signature }
    : undefined;
}

/** The DER SubjectPublicKeyInfo prefix of a compressed P-256 public key (RFC 5480). */
const SPKI_COMPRESSED_PREFIX = Buffer.from(
  "3039301306072a8648ce3d020106082a8648ce3d030107032200",
  "hex",
);

/**
 * Checks a stamp as Turnkey does: the P-256 scheme, the expected public key, and a DER signature
 * over the body that verifies with that key.
 *
 * @param header - The `X-Stamp` header value.
 * @param body - The body the request sent.
 * @param publicKey - The expected compressed public key, in hex.
 * @returns Whether the stamp is valid.
 */
export function verifyStamp(header: string, body: string, publicKey: string): boolean {
  const stamp = parseStamp(header);
  if (
    stamp === undefined ||
    stamp.scheme !== STAMP_SCHEME ||
    stamp.publicKey.toLowerCase() !== publicKey.toLowerCase() ||
    !/^(?:[0-9a-fA-F]{2})+$/.test(stamp.signature)
  ) {
    return false;
  }
  // 33 bytes of hex and nothing else: Buffer.from stops at the first character that is not hex,
  // and node reads a SubjectPublicKeyInfo with bytes left after the key.
  const keyBytes = Buffer.from(stamp.publicKey, "hex");
  if (keyBytes.length !== 33 || keyBytes.toString("hex") !== stamp.publicKey.toLowerCase()) {
    return false;
  }
  let key: KeyObject;
  try {
    // Fails unless the key is a compressed point on P-256: 02 or 03, then x.
    key = createPublicKey({
      key: Buffer.concat([SPKI_COMPRESSED_PREFIX, keyBytes]),
      format: "der",
      type: "spki",
    });
  } catch {
    return false;
  }
  return verify(
    "sha256",
    Buffer.from(body),
    { key, dsaEncoding: "der" },
    Buffer.from(stamp.signature, "hex"),
  );
}
