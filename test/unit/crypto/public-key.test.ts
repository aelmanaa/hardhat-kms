import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";

import {
  assertOnCurve,
  InvalidPublicKeyError,
  publicKeyFromJwk,
  publicKeyFromSpkiDer,
  publicKeyFromSpkiPem,
} from "../../../src/internal/crypto/public-key.ts";

function secp256k1KeyPair() {
  return generateKeyPairSync("ec", { namedCurve: "secp256k1" });
}

function secretKeyOf(value: bigint): Uint8Array {
  return Uint8Array.from(Buffer.from(value.toString(16).padStart(64, "0"), "hex"));
}

function stripZeros(bytes: Uint8Array): Uint8Array {
  return bytes.slice(bytes.findIndex((byte) => byte !== 0));
}

function expectedPublicKey(jwkX: string, jwkY: string): Uint8Array {
  return Uint8Array.from([
    0x04,
    ...Buffer.from(jwkX, "base64url"),
    ...Buffer.from(jwkY, "base64url"),
  ]);
}

describe("public keys", () => {
  it("parses SPKI DER, as AWS KMS returns it", () => {
    const { publicKey } = secp256k1KeyPair();
    const jwk = publicKey.export({ format: "jwk" });
    const der = new Uint8Array(publicKey.export({ format: "der", type: "spki" }));

    assert.deepEqual(publicKeyFromSpkiDer(der), expectedPublicKey(jwk.x ?? "", jwk.y ?? ""));
  });

  it("parses SPKI PEM, as GCP Cloud KMS returns it", () => {
    const { publicKey } = secp256k1KeyPair();
    const jwk = publicKey.export({ format: "jwk" });
    const pem = publicKey.export({ format: "pem", type: "spki" }).toString();

    assert.deepEqual(publicKeyFromSpkiPem(pem), expectedPublicKey(jwk.x ?? "", jwk.y ?? ""));
  });

  it("rejects SPKI keys on another curve or of another type", () => {
    const p256 = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey;
    const ed25519 = generateKeyPairSync("ed25519").publicKey;

    for (const key of [p256, ed25519]) {
      const der = new Uint8Array(key.export({ format: "der", type: "spki" }));
      assert.throws(
        () => publicKeyFromSpkiDer(der),
        (error: unknown) =>
          error instanceof InvalidPublicKeyError &&
          error.message.startsWith("expected a secp256k1 key"),
      );
    }
  });

  it("accepts only the canonical uncompressed SPKI encoding", () => {
    const der = new Uint8Array(
      secp256k1KeyPair().publicKey.export({ format: "der", type: "spki" }),
    );
    const point = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true);
    const compressed = Uint8Array.from([
      ...Buffer.from("3036301006072a8648ce3d020106052b8104000a032200", "hex"),
      ...point,
    ]);

    assert.equal(publicKeyFromSpkiDer(der).length, 65);
    assert.throws(() => publicKeyFromSpkiDer(Uint8Array.from([...der, 0])), InvalidPublicKeyError);
    assert.throws(() => publicKeyFromSpkiDer(compressed), /canonical DER encoding/);
  });

  it("rejects bytes that are not SPKI", () => {
    assert.throws(() => publicKeyFromSpkiDer(Uint8Array.of(1, 2, 3)), InvalidPublicKeyError);
    assert.throws(() => publicKeyFromSpkiPem("not a pem"), InvalidPublicKeyError);
  });

  // Secret keys 153, 122 and 55959 are the smallest whose public key has a zero first byte in
  // x only, y only, and both coordinates.
  for (const [secret, zeroIn] of [
    [153n, "x"],
    [122n, "y"],
    [55959n, "x and y"],
  ] as const) {
    it(`left-pads JWK coordinates that lost leading zeros (${zeroIn}), as Azure may return them`, () => {
      const full = secp256k1.getPublicKey(secretKeyOf(secret), false);
      const x = full.slice(1, 33);
      const y = full.slice(33);
      assert.ok(zeroIn.includes("x") === (x[0] === 0) && zeroIn.includes("y") === (y[0] === 0));

      assert.deepEqual(
        publicKeyFromJwk({ kty: "EC", crv: "P-256K", x: stripZeros(x), y: stripZeros(y) }),
        full,
      );
      assert.deepEqual(
        publicKeyFromJwk({
          kty: "EC-HSM",
          crv: "P-256K",
          x: Buffer.from(stripZeros(x)).toString("base64url"),
          y: Buffer.from(stripZeros(y)).toString("base64url"),
        }),
        full,
      );
      assert.deepEqual(publicKeyFromJwk({ kty: "EC", crv: "P-256K", x, y }), full);
    });
  }

  it("rejects an empty coordinate", () => {
    const full = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), false);

    assert.throws(
      () => publicKeyFromJwk({ kty: "EC", crv: "P-256K", x: new Uint8Array(0), y: full.slice(33) }),
      InvalidPublicKeyError,
    );
  });

  it("rejects compressed public keys", () => {
    const compressed = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true);

    assert.throws(() => assertOnCurve(compressed), InvalidPublicKeyError);
  });

  it("rejects JWKs with the wrong key type, curve or missing coordinates", () => {
    const full = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), false);
    const x = full.slice(1, 33);
    const y = full.slice(33);

    assert.throws(
      () => publicKeyFromJwk({ kty: "RSA", crv: "P-256K", x, y }),
      InvalidPublicKeyError,
    );
    assert.throws(() => publicKeyFromJwk({ kty: "EC", crv: "P-256", x, y }), InvalidPublicKeyError);
    assert.throws(() => publicKeyFromJwk({ kty: "EC", crv: "P-256K", y }), InvalidPublicKeyError);
    assert.throws(
      () => publicKeyFromJwk({ kty: "EC", crv: "P-256K", x: new Uint8Array(33), y }),
      InvalidPublicKeyError,
    );
  });

  it("rejects points that are not on the curve", () => {
    const full = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), false);
    const tampered = full.slice();
    tampered[64] = (tampered[64] ?? 0) ^ 1;

    assert.throws(() => assertOnCurve(tampered), InvalidPublicKeyError);
    assert.throws(() => assertOnCurve(full.slice(0, 64)), InvalidPublicKeyError);
    assert.throws(
      () => assertOnCurve(Uint8Array.from([0x02, ...full.slice(1)])),
      InvalidPublicKeyError,
    );
  });
});
