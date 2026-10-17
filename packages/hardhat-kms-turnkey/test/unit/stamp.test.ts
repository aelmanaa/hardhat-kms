import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import { verifyStampSignature } from "@turnkey/crypto";

import {
  apiKeyFromPrivateKey,
  parseStamp,
  samePublicKey,
  STAMP_HEADER,
  STAMP_SCHEME,
  stampBody,
  verifyStamp,
} from "../../src/internal/stamp.ts";
import { API_PRIVATE_KEY, API_PUBLIC_KEY, OTHER_API_PRIVATE_KEY } from "../helpers/keys.ts";

const BODY = JSON.stringify({ type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2", timestampMs: "1" });
/** The P-256 group order: the first value that is not a private key. */
const P256_ORDER = "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551";

function key() {
  const apiKey = apiKeyFromPrivateKey(API_PRIVATE_KEY);
  assert.ok(apiKey);
  return apiKey;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("the API key", () => {
  it("derives the compressed public key from the private key", () => {
    // Turnkey's stamper derives the JWK from the same pair, so it accepts this public key only if
    // it belongs to the private key: the cross-check below fails otherwise.
    assert.match(key().publicKey, /^0[23][0-9a-f]{64}$/);
    assert.equal(apiKeyFromPrivateKey(API_PRIVATE_KEY.toUpperCase())?.publicKey, API_PUBLIC_KEY);
  });

  for (const [name, value] of [
    ["63 hex characters", API_PRIVATE_KEY.slice(1)],
    ["65 hex characters", `${API_PRIVATE_KEY}0`],
    ["a 0x prefix", `0x${API_PRIVATE_KEY.slice(2)}`],
    ["a character that is not hex", `${API_PRIVATE_KEY.slice(1)}g`],
    ["the public key", API_PUBLIC_KEY],
    ["zero", "00".repeat(32)],
    ["the group order", P256_ORDER],
    ["empty", ""],
  ] as const) {
    it(`refuses a private key that is ${name}`, () => {
      assert.equal(apiKeyFromPrivateKey(value), undefined);
    });
  }

  it("accepts the largest private key, one below the group order", () => {
    assert.ok(apiKeyFromPrivateKey(`${P256_ORDER.slice(0, -1)}0`));
  });

  it("compares a configured public key in any case", () => {
    assert.equal(samePublicKey(API_PUBLIC_KEY.toUpperCase(), API_PUBLIC_KEY), true);
    const other = apiKeyFromPrivateKey(OTHER_API_PRIVATE_KEY);
    assert.ok(other);
    assert.equal(samePublicKey(other.publicKey, API_PUBLIC_KEY), false);
  });
});

describe("the stamp", () => {
  it("has the documented shape", () => {
    assert.equal(STAMP_HEADER, "X-Stamp");
    const header = stampBody(BODY, key());
    assert.match(header, /^[A-Za-z0-9_-]+$/);
    const json: unknown = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    assert.deepEqual(Object.keys(json ?? {}), ["publicKey", "scheme", "signature"]);
    const stamp = parseStamp(header);
    assert.ok(stamp);
    assert.equal(stamp.publicKey, API_PUBLIC_KEY);
    assert.equal(stamp.scheme, STAMP_SCHEME);
    assert.equal(STAMP_SCHEME, "SIGNATURE_SCHEME_TK_API_P256");
    // A DER ECDSA signature: a SEQUENCE of two INTEGERs, in hex.
    assert.match(stamp.signature, /^30[0-9a-f]{2}02[0-9a-f]+$/);
    assert.equal(stamp.signature.length / 2, Number.parseInt(stamp.signature.slice(2, 4), 16) + 2);
  });

  it("verifies with Turnkey's verifier", async () => {
    const stamp = parseStamp(stampBody(BODY, key()));
    assert.ok(stamp);
    assert.equal(await verifyStampSignature(stamp.publicKey, stamp.signature, BODY), true);
    assert.equal(await verifyStampSignature(stamp.publicKey, stamp.signature, `${BODY} `), false);
  });

  it("verifies a stamp from Turnkey's stamper, and only for its body and key", async () => {
    const stamper = new ApiKeyStamper({
      apiPublicKey: API_PUBLIC_KEY,
      apiPrivateKey: API_PRIVATE_KEY,
    });
    const { stampHeaderName, stampHeaderValue } = await stamper.stamp(BODY);

    assert.equal(stampHeaderName, STAMP_HEADER);
    assert.equal(verifyStamp(stampHeaderValue, BODY, API_PUBLIC_KEY), true);
    assert.equal(verifyStamp(stampHeaderValue, BODY, API_PUBLIC_KEY.toUpperCase()), true);
    assert.equal(verifyStamp(stampHeaderValue, `${BODY} `, API_PUBLIC_KEY), false);
    const other = apiKeyFromPrivateKey(OTHER_API_PRIVATE_KEY);
    assert.ok(other);
    assert.equal(verifyStamp(stampHeaderValue, BODY, other.publicKey), false);
  });

  it("signs anew each time, and each stamp verifies", () => {
    const first = stampBody(BODY, key());
    const second = stampBody(BODY, key());
    assert.notEqual(first, second);
    assert.equal(verifyStamp(first, BODY, API_PUBLIC_KEY), true);
    assert.equal(verifyStamp(second, BODY, API_PUBLIC_KEY), true);
  });

  it("refuses a stamp of another scheme, a key that is not compressed, or a broken signature", () => {
    const stamp = parseStamp(stampBody(BODY, key()));
    assert.ok(stamp);
    const variants = {
      scheme: { ...stamp, scheme: "SIGNATURE_SCHEME_TK_API_SECP256K1" },
      "uncompressed key": { ...stamp, publicKey: `04${API_PUBLIC_KEY.slice(2)}${"00".repeat(32)}` },
      "odd signature": { ...stamp, signature: `${stamp.signature}0` },
      "signature not hex": { ...stamp, signature: `${stamp.signature.slice(0, -2)}zz` },
      "empty signature": { ...stamp, signature: "" },
      "signature not DER": { ...stamp, signature: "00".repeat(64) },
    };
    for (const [name, variant] of Object.entries(variants)) {
      assert.equal(verifyStamp(base64urlJson(variant), BODY, variant.publicKey), false, name);
    }
  });

  it("refuses a key that is not on the curve", () => {
    // 02 followed by an x with no point on P-256: x = 1 has no y.
    const offCurve = `02${"00".repeat(31)}01`;
    const stamp = parseStamp(stampBody(BODY, key()));
    assert.ok(stamp);
    assert.equal(
      verifyStamp(base64urlJson({ ...stamp, publicKey: offCurve }), BODY, offCurve),
      false,
    );
  });

  it("reads only a stamp's JSON", () => {
    assert.equal(parseStamp("not base64url json"), undefined);
    assert.equal(parseStamp(base64urlJson(null)), undefined);
    assert.equal(parseStamp(base64urlJson("text")), undefined);
    assert.equal(parseStamp(base64urlJson({ publicKey: "a", scheme: "b" })), undefined);
    assert.equal(parseStamp(base64urlJson({ publicKey: "a", signature: "c" })), undefined);
    assert.equal(parseStamp(base64urlJson({ scheme: "b", signature: "c" })), undefined);
    assert.deepEqual(parseStamp(base64urlJson({ publicKey: "a", scheme: "b", signature: "c" })), {
      publicKey: "a",
      scheme: "b",
      signature: "c",
    });
    assert.equal(verifyStamp("not base64url json", BODY, API_PUBLIC_KEY), false);
  });
});
