import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import * as fc from "fast-check";

import {
  InvalidSignatureError,
  normalizeSignature,
  parseRpcSignature,
  parseSignature,
  recoverAddress,
  recoverPublicKey,
  recoverYParity,
  toLowS,
  toRpcSignature,
} from "../../../src/internal/crypto/signature.ts";
import { ERRORS } from "../../../src/internal/error-catalog.ts";
import { catalogMessage } from "../../../src/internal/errors.ts";

const N = secp256k1.Point.CURVE().n;

/** Matches an `InvalidSignatureError` whose message is exactly `message`, a catalogue entry's. */
function invalidSignature(message: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof InvalidSignatureError &&
    error.name === "InvalidSignatureError" &&
    error.message === message;
}

const NO_RECOVERY = invalidSignature(catalogMessage(ERRORS.signatureNoRecovery, {}));

/**
 * Whether `x` is the x coordinate of a secp256k1 point: whether x^3 + 7 is a square mod p, by
 * Euler's criterion, computed in noble's field.
 */
function isCurveX(x: bigint): boolean {
  const { Fp } = secp256k1.Point;
  const rhs = Fp.add(Fp.pow(Fp.create(x), 3n), Fp.create(secp256k1.Point.CURVE().b));
  return Fp.eql(Fp.pow(rhs, (Fp.ORDER - 1n) >> 1n), Fp.ONE);
}

/** The smallest `r` that is no point's x coordinate, so no public key recovers from it: 5. */
const OFF_CURVE_R = (() => {
  let r = 1n;
  while (isCurveX(r)) {
    r++;
  }
  return r;
})();

function signCompact(digest: Uint8Array, secretKey: Uint8Array) {
  return secp256k1.Signature.fromBytes(
    secp256k1.sign(digest, secretKey, { prehash: false, lowS: true, format: "compact" }),
    "compact",
  );
}

const digestArb = fc.uint8Array({ minLength: 32, maxLength: 32 });
const secretKeyArb = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .filter((bytes) => secp256k1.utils.isValidSecretKey(bytes));

describe("signatures", () => {
  it("normalizes DER, compact and split signatures, high-S or not, to the same result", () => {
    fc.assert(
      fc.property(digestArb, secretKeyArb, fc.boolean(), (digest, secretKey, highS) => {
        const publicKey = secp256k1.getPublicKey(secretKey, false);
        const signature = signCompact(digest, secretKey);
        const s = highS ? N - signature.s : signature.s;
        const variant = new secp256k1.Signature(signature.r, s);

        const fromDer = normalizeSignature(
          { format: "der", bytes: variant.toBytes("der") },
          digest,
          publicKey,
        );
        const fromCompact = normalizeSignature(
          { format: "compact", bytes: variant.toBytes("compact") },
          digest,
          publicKey,
        );
        const fromSplit = normalizeSignature({ r: signature.r, s }, digest, publicKey);

        assert.deepEqual(fromDer, fromCompact);
        assert.deepEqual(fromDer, fromSplit);
        assert.equal(fromDer.s, signature.s);
        assert.ok(fromDer.s <= N >> 1n);
      }),
      { numRuns: 200 },
    );
  });

  it("recovers the right parity for every signature", () => {
    fc.assert(
      fc.property(digestArb, secretKeyArb, (digest, secretKey) => {
        const recovered = secp256k1.sign(digest, secretKey, {
          prehash: false,
          lowS: true,
          format: "recovered",
        });
        const expectedParity = recovered[0];
        const signature = signCompact(digest, secretKey);

        assert.equal(
          recoverYParity(
            digest,
            signature.r,
            signature.s,
            secp256k1.getPublicKey(secretKey, false),
          ),
          expectedParity,
        );
      }),
      { numRuns: 200 },
    );
  });

  it("throws, never guesses, when the signature is from another key", () => {
    fc.assert(
      fc.property(digestArb, secretKeyArb, secretKeyArb, (digest, signingKey, expectedKey) => {
        fc.pre(!signingKey.every((byte, index) => byte === expectedKey[index]));
        const signature = signCompact(digest, signingKey);

        assert.throws(
          () =>
            normalizeSignature(
              { format: "compact", bytes: signature.toBytes("compact") },
              digest,
              secp256k1.getPublicKey(expectedKey, false),
            ),
          NO_RECOVERY,
        );
      }),
      { numRuns: 100 },
    );
  });

  it("throws from recoverYParity when neither parity gives the expected key", () => {
    const digest = keccak_256(Uint8Array.of(3));
    const signature = signCompact(digest, secp256k1.utils.randomSecretKey());
    const otherKey = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), false);

    assert.throws(() => recoverYParity(digest, signature.r, signature.s, otherKey), NO_RECOVERY);
  });

  it("throws from recoverYParity when r is no point's x coordinate, so neither parity recovers", () => {
    const digest = keccak_256(Uint8Array.of(3));
    const publicKey = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), false);
    assert.equal(OFF_CURVE_R, 5n);
    assert.ok(isCurveX(1n) && isCurveX(secp256k1.Point.CURVE().Gx));
    assert.throws(() => secp256k1.Point.fromHex(`02${word(OFF_CURVE_R)}`));

    assert.throws(() => recoverYParity(digest, OFF_CURVE_R, 1n, publicKey), NO_RECOVERY);
  });

  it("rejects random bytes as DER", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 80 }), (bytes) => {
        let parsed: { r: bigint; s: bigint } | undefined;
        try {
          parsed = parseSignature({ format: "der", bytes });
        } catch (error) {
          assert.ok(
            invalidSignature(catalogMessage(ERRORS.signatureParse, { format: "der" }))(error) ||
              invalidSignature(catalogMessage(ERRORS.signatureRange, {}))(error),
          );
          return;
        }
        // The rare random input that is valid DER must round-trip exactly.
        assert.deepEqual(new secp256k1.Signature(parsed.r, parsed.s).toBytes("der"), bytes);
      }),
      { numRuns: 500 },
    );
  });

  it("rejects DER with trailing bytes and compact signatures of the wrong length", () => {
    const signature = signCompact(keccak_256(Uint8Array.of(1)), secp256k1.utils.randomSecretKey());
    const der = signature.toBytes("der");

    assert.throws(
      () => parseSignature({ format: "der", bytes: Uint8Array.from([...der, 0]) }),
      invalidSignature(catalogMessage(ERRORS.signatureParse, { format: "der" })),
    );
    for (const length of [63, 65]) {
      assert.throws(
        () => parseSignature({ format: "compact", bytes: new Uint8Array(length) }),
        invalidSignature(catalogMessage(ERRORS.signatureCompactLength, { length })),
      );
    }
  });

  it("rejects signature formats other than der and compact, without echoing them", () => {
    // What a buggy adapter might return; the type forbids it, so go around the type.
    const output: unknown = { format: "hhkms-secret-format", bytes: new Uint8Array(64) };

    assert.throws(
      () => Reflect.apply(parseSignature, undefined, [output]),
      invalidSignature(catalogMessage(ERRORS.signatureFormat, {})),
    );
  });

  it("rejects scalars outside [1, n - 1]", () => {
    for (const [r, s] of [
      [0n, 1n],
      [1n, 0n],
      [N, 1n],
      [1n, N],
    ] as const) {
      assert.throws(
        () => parseSignature({ r, s }),
        invalidSignature(catalogMessage(ERRORS.signatureRange, {})),
      );
    }
  });

  it("leaves low S untouched and folds high S", () => {
    assert.equal(toLowS(1n), 1n);
    assert.equal(toLowS(N >> 1n), N >> 1n);
    assert.equal(toLowS((N >> 1n) + 1n), N - ((N >> 1n) + 1n));
  });

  it("returns undefined when no public key can be recovered", () => {
    const digest = keccak_256(Uint8Array.of(2));

    assert.equal(recoverPublicKey(digest, OFF_CURVE_R, 1n, 0), undefined);
    assert.equal(recoverPublicKey(digest, OFF_CURVE_R, 1n, 1), undefined);
  });

  it("rejects digests that are not 32 bytes", () => {
    assert.throws(
      () => recoverPublicKey(new Uint8Array(31), 1n, 1n, 0),
      invalidSignature(catalogMessage(ERRORS.signatureDigestLength, { length: 31 })),
    );
  });

  it("encodes RPC signatures as r || s || v with v = 27 + yParity, left-padded", () => {
    const r = "0".repeat(63) + "1";
    const s = "0".repeat(63) + "2";

    assert.equal(toRpcSignature({ r: 1n, s: 2n, yParity: 1 }), `0x${r}${s}1c`);
    assert.equal(toRpcSignature({ r: 1n, s: 2n, yParity: 0 }), `0x${r}${s}1b`);
  });
});

/** A 32-byte word as 64 hex digits. */
function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

/** An `r || s || v` signature as hex. */
function rpc(r: bigint, s: bigint, v: number): string {
  return `0x${word(r)}${word(s)}${v.toString(16).padStart(2, "0")}`;
}

function rejects(signature: string, message: string): void {
  assert.throws(() => parseRpcSignature(signature), invalidSignature(message), signature);
}

const NOT_HEX = catalogMessage(ERRORS.signatureHex, {});
const OUT_OF_RANGE = catalogMessage(ERRORS.signatureRange, {});

/** The recovery bit `parseRpcSignature` reads from a signature. */
function bit(signature: string): 0 | 1 {
  return parseRpcSignature(signature).signature.yParity;
}

describe("parseRpcSignature and recoverAddress", () => {
  it("round-trips toRpcSignature, and recovers the signer's address", () => {
    fc.assert(
      fc.property(digestArb, secretKeyArb, (digest, secretKey) => {
        const { r, s } = signCompact(digest, secretKey);
        const publicKey = secp256k1.getPublicKey(secretKey, false);
        const signature = { r, s, yParity: recoverYParity(digest, r, s, publicKey) };

        const parsed = parseRpcSignature(toRpcSignature(signature));

        assert.deepEqual(parsed, { signature, highS: false });
        const address = `0x${Buffer.from(keccak_256(publicKey.subarray(1)).subarray(12)).toString("hex")}`;
        assert.equal(recoverAddress(digest, parsed.signature).toLowerCase(), address);
      }),
      { numRuns: 25 },
    );
  });

  it("folds a high-S signature to its low-S twin, which recovers the same signer", () => {
    fc.assert(
      fc.property(digestArb, secretKeyArb, (digest, secretKey) => {
        const { r, s } = signCompact(digest, secretKey);
        const publicKey = secp256k1.getPublicKey(secretKey, false);
        const yParity = recoverYParity(digest, r, s, publicKey);
        const low = { r, s, yParity };
        const high = toRpcSignature({ r, s: N - s, yParity: yParity === 0 ? 1 : 0 });

        const parsed = parseRpcSignature(high);

        assert.deepEqual(parsed, { signature: low, highS: true });
        assert.equal(recoverAddress(digest, parsed.signature), recoverAddress(digest, low));
      }),
      { numRuns: 25 },
    );
  });

  it("treats the highest low S as low and the lowest high S as high", () => {
    assert.equal(parseRpcSignature(rpc(1n, N >> 1n, 27)).highS, false);
    assert.deepEqual(parseRpcSignature(rpc(1n, (N >> 1n) + 1n, 27)), {
      signature: { r: 1n, s: N - ((N >> 1n) + 1n), yParity: 1 },
      highS: true,
    });
    assert.deepEqual(parseRpcSignature(rpc(1n, N - 1n, 28)).signature, {
      r: 1n,
      s: 1n,
      yParity: 0,
    });
  });

  it("reads v as alloy does: 0/1, 27/28, or EIP-155 values from 35", () => {
    assert.equal(bit(rpc(1n, 2n, 27)), 0);
    assert.equal(bit(rpc(1n, 2n, 28)), 1);
    assert.equal(bit(rpc(1n, 2n, 0)), 0);
    assert.equal(bit(rpc(1n, 2n, 1)), 1);
    assert.equal(bit(rpc(1n, 2n, 35)), 0);
    assert.equal(bit(rpc(1n, 2n, 36)), 1);
    // Chain id 1: v = 37 or 38.
    assert.equal(bit(rpc(1n, 2n, 37)), 0);
    assert.equal(bit(rpc(1n, 2n, 38)), 1);
    assert.equal(bit(rpc(1n, 2n, 255)), 0);
    assert.equal(bit(rpc(1n, 2n, 28).toUpperCase().replace("0X", "0x")), 1);
  });

  it("refuses the v values alloy refuses: 2 to 26 and 29 to 34", () => {
    for (const v of [2, 26, 29, 34]) {
      rejects(rpc(1n, 2n, v), catalogMessage(ERRORS.signatureV, { v }));
    }
  });

  it("refuses input that is not 0x-prefixed hex", () => {
    rejects(rpc(1n, 2n, 27).slice(2), NOT_HEX);
    rejects(`${rpc(1n, 2n, 27).slice(0, -1)}g`, NOT_HEX);
    // 130 hex digits after the 0x, but the 0x is not at the start.
    rejects(`a${rpc(1n, 2n, 27).slice(0, -1)}`, NOT_HEX);
  });

  it("refuses signatures that are not 65 bytes", () => {
    rejects("0x", catalogMessage(ERRORS.signatureRpcLength, { digits: 0 }));
    rejects(
      rpc(1n, 2n, 27).slice(0, -2),
      catalogMessage(ERRORS.signatureRpcLength, { digits: 128 }),
    );
    rejects(`${rpc(1n, 2n, 27)}0`, catalogMessage(ERRORS.signatureRpcLength, { digits: 131 }));
  });

  it("refuses r or s outside [1, n - 1]", () => {
    rejects(rpc(0n, 2n, 27), OUT_OF_RANGE);
    rejects(rpc(1n, 0n, 27), OUT_OF_RANGE);
    rejects(rpc(N, 2n, 27), OUT_OF_RANGE);
    rejects(rpc(1n, N, 27), OUT_OF_RANGE);
  });

  it("fails when no public key recovers", () => {
    const digest = keccak_256(Uint8Array.of(2));

    assert.throws(
      () => recoverAddress(digest, { r: OFF_CURVE_R, s: 1n, yParity: 0 }),
      invalidSignature(catalogMessage(ERRORS.signatureNoPublicKey, {})),
    );
  });
});
