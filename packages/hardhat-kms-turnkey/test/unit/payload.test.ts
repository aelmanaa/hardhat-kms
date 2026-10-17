import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { keccak_256 } from "@noble/hashes/sha3.js";
import type { TypedData } from "hardhat-kms/types";
import { hashTypedData, serializeTypedData } from "viem";

import {
  personalMessageDigest,
  typedDataDigest,
} from "../../../hardhat-kms/src/internal/crypto/digests.ts";
import { EIP712_MAIL } from "../../../hardhat-kms/test/helpers/vectors.ts";
import { digestPayload, messagePayload, typedDataPayload } from "../../src/internal/payload.ts";

/** The typed data as Turnkey reads it back from the payload. */
function parsed(payload: string): TypedData {
  const value: unknown = JSON.parse(payload);
  assert.ok(typeof value === "object" && value !== null);
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const { types, primaryType, domain, message } = fields;
  assert.ok(typeof types === "object" && types !== null);
  assert.ok(typeof domain === "object" && domain !== null);
  assert.ok(typeof message === "object" && message !== null);
  assert.equal(typeof primaryType, "string");
  return {
    types: Object.fromEntries(Object.entries(types)),
    primaryType: String(primaryType),
    domain: Object.fromEntries(Object.entries(domain)),
    message: Object.fromEntries(Object.entries(message)),
  };
}

describe("payloads", () => {
  it("sends a digest as 64 hex characters, unhashed", () => {
    const digest = new Uint8Array(32).map((_, index) => index + 0xa0);
    assert.deepEqual(digestPayload(digest), {
      payload: Buffer.from(digest).toString("hex"),
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NO_OP",
    });
    assert.equal(digestPayload(digest).payload.length, 64);
  });

  it("sends a message as its EIP-191 preimage, which Turnkey hashes with Keccak-256", () => {
    const message = new TextEncoder().encode("hello, Turnkey: ünïcode");
    const { payload, encoding, hashFunction } = messagePayload(message);
    assert.equal(encoding, "PAYLOAD_ENCODING_HEXADECIMAL");
    assert.equal(hashFunction, "HASH_FUNCTION_KECCAK256");
    assert.match(payload, /^(?:[0-9a-f]{2})+$/);
    const bytes = Buffer.from(payload, "hex");
    assert.equal(
      bytes.toString("latin1").startsWith(`\x19Ethereum Signed Message:\n${message.length}`),
      true,
    );
    // The byte length, not the character count: the core's digest is over the same preimage.
    assert.deepEqual(keccak_256(bytes), personalMessageDigest(message));
  });

  it("sends an empty and a binary message with their lengths", () => {
    for (const message of [new Uint8Array(), new Uint8Array([0, 255, 10, 0x19])]) {
      const bytes = Buffer.from(messagePayload(message).payload, "hex");
      assert.deepEqual(keccak_256(bytes), personalMessageDigest(message));
    }
  });

  it("sends typed data as JSON that hashes to the core's digest, as viem serializes it", () => {
    const { payload, encoding, hashFunction } = typedDataPayload(EIP712_MAIL);
    assert.equal(encoding, "PAYLOAD_ENCODING_EIP712");
    assert.equal(hashFunction, "HASH_FUNCTION_NO_OP");
    assert.deepEqual(typedDataDigest(parsed(payload)), typedDataDigest(EIP712_MAIL));
    assert.deepEqual(parsed(payload).types, parsed(serializeTypedData(EIP712_MAIL)).types);
  });

  it("adds the EIP712Domain type in EIP-712's order when the request has none", () => {
    const { EIP712Domain: _domainType, ...types } = EIP712_MAIL.types;
    const typedData: TypedData = {
      ...EIP712_MAIL,
      types,
      // Out of order, and without `version`.
      domain: {
        verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
        salt: `0x${"ab".repeat(32)}`,
        chainId: 10n,
        name: "Ether Mail",
      },
    };
    const sent = parsed(typedDataPayload(typedData).payload);

    assert.deepEqual(sent.types.EIP712Domain, [
      { name: "name", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
    ]);
    // A bigint is sent as decimal text, as viem sends it.
    assert.equal(sent.domain.chainId, "10");
    assert.deepEqual(typedDataDigest(sent), typedDataDigest(typedData));
    assert.equal(
      Buffer.from(typedDataDigest(typedData)).toString("hex"),
      hashTypedData(typedData).slice(2),
    );
    // The caller's object is not changed.
    assert.equal(typedData.types.EIP712Domain, undefined);
  });

  it("keeps the request's own EIP712Domain type, and an empty domain gets an empty one", () => {
    // Not in EIP-712's order: the request's own type wins over the derived one.
    const own = [
      { name: "version", type: "string" },
      { name: "name", type: "string" },
    ];
    const withOwn = parsed(
      typedDataPayload({
        ...EIP712_MAIL,
        domain: { name: "x", version: "1" },
        types: { ...EIP712_MAIL.types, EIP712Domain: own },
      }).payload,
    );
    assert.deepEqual(withOwn.types.EIP712Domain, own);

    const { EIP712Domain: _domainType, ...types } = EIP712_MAIL.types;
    const empty = parsed(typedDataPayload({ ...EIP712_MAIL, types, domain: {} }).payload);
    assert.deepEqual(empty.types.EIP712Domain, []);
  });

  it("does not count an inherited domain field", () => {
    const { EIP712Domain: _domainType, ...types } = EIP712_MAIL.types;
    const domain: Record<string, unknown> = Object.create({ name: "inherited" });
    domain.version = "1";
    const sent = parsed(typedDataPayload({ ...EIP712_MAIL, types, domain }).payload);
    assert.deepEqual(sent.types.EIP712Domain, [{ name: "version", type: "string" }]);
  });
});
