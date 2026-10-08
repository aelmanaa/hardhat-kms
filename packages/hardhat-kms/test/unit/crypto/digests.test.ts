import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { eip191Signer, signTyped } from "micro-eth-signer";

import {
  addressFromPublicKey,
  InvalidAddressError,
  sameAddress,
  toChecksumAddress,
} from "../../../src/internal/crypto/address.ts";
import { crc32c } from "../../../src/internal/crypto/crc32c.ts";
import {
  InvalidTypedDataError,
  parseTypedData,
  personalMessageDigest,
  typedDataDigest,
  verifyPersonalMessageSignature,
  verifyTypedDataSignature,
} from "../../../src/internal/crypto/digests.ts";
import { InvalidPublicKeyError } from "../../../src/internal/crypto/public-key.ts";
import { ERRORS } from "../../../src/internal/error-catalog.ts";
import { catalogMessage } from "../../../src/internal/errors.ts";
import { EIP712_MAIL } from "../../helpers/vectors.ts";

/** Matches an `InvalidTypedDataError` whose message is exactly `message`, a catalogue entry's. */
function invalidTypedData(message: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof InvalidTypedDataError &&
    error.name === "InvalidTypedDataError" &&
    error.message === message;
}

describe("digests", () => {
  it("computes the EIP-712 digest of the specification example", () => {
    assert.equal(
      Buffer.from(typedDataDigest(EIP712_MAIL)).toString("hex"),
      // From the EIP-712 specification's reference implementation.
      "be609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2",
    );
  });

  it("agrees with micro-eth-signer's published signTyped/verifyTyped", () => {
    const secretKey = secp256k1.utils.randomSecretKey();
    const address = addressFromPublicKey(secp256k1.getPublicKey(secretKey, false));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fixed, valid example
    const signature = signTyped(EIP712_MAIL as Parameters<typeof signTyped>[0], secretKey, false);

    assert.ok(verifyTypedDataSignature(signature, EIP712_MAIL, address));
    const digest = typedDataDigest(EIP712_MAIL);
    const recovered = secp256k1.Signature.fromBytes(
      Buffer.from(signature.slice(2, 130), "hex"),
      "compact",
    )
      .addRecoveryBit(Number.parseInt(signature.slice(130), 16) - 27)
      .recoverPublicKey(digest)
      .toBytes(false);
    assert.ok(sameAddress(addressFromPublicKey(recovered), address));
  });

  it("computes the EIP-191 digest like micro-eth-signer", () => {
    const message = new TextEncoder().encode("hello");

    assert.equal(
      `0x${Buffer.from(personalMessageDigest(message)).toString("hex")}`,
      eip191Signer._getHash(message),
    );
  });

  it("verifies personal-message signatures with the published verifier", () => {
    const secretKey = secp256k1.utils.randomSecretKey();
    const address = addressFromPublicKey(secp256k1.getPublicKey(secretKey, false));
    const message = Uint8Array.of(1, 2, 3);
    const signature = eip191Signer.sign(message, secretKey, false);

    assert.ok(verifyPersonalMessageSignature(signature, message, address));
    assert.ok(!verifyPersonalMessageSignature(signature, Uint8Array.of(1, 2, 4), address));
  });
});

describe("CRC-32C", () => {
  it("matches the standard check value and RFC 3720 vectors", () => {
    assert.equal(crc32c(new TextEncoder().encode("123456789")), 0xe3069283);
    assert.equal(crc32c(new Uint8Array(32)), 0x8a9136aa);
    assert.equal(crc32c(new Uint8Array(32).fill(0xff)), 0x62a8ab43);
    assert.equal(crc32c(new Uint8Array(0)), 0);
  });
});

describe("addresses", () => {
  it("derives Hardhat's first default account", () => {
    const secretKey = Buffer.from(
      "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      "hex",
    );

    assert.equal(
      addressFromPublicKey(secp256k1.getPublicKey(secretKey, false)),
      "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    );
  });

  it("refuses to derive an address from an off-curve key", () => {
    const tampered = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), false);
    tampered[64] = (tampered[64] ?? 0) ^ 1;

    assert.throws(() => addressFromPublicKey(tampered), InvalidPublicKeyError);
  });

  it("compares addresses case-insensitively", () => {
    assert.ok(
      sameAddress(
        "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      ),
    );
    assert.ok(
      !sameAddress(
        "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        "0x0000000000000000000000000000000000000000",
      ),
    );
  });

  it("checksums lowercase and uppercase addresses and keeps valid checksums", () => {
    const checksummed = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

    assert.equal(toChecksumAddress(checksummed.toLowerCase()), checksummed);
    assert.equal(toChecksumAddress(`0x${checksummed.slice(2).toUpperCase()}`), checksummed);
    assert.equal(toChecksumAddress(checksummed), checksummed);
  });

  it("rejects malformed addresses and wrong checksums", () => {
    for (const address of [
      "",
      "0x",
      "f39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb9226",
      "0xg39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      "0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      "0Xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    ]) {
      assert.throws(
        () => toChecksumAddress(address),
        (error: unknown) =>
          error instanceof InvalidAddressError &&
          error.name === "InvalidAddressError" &&
          error.message === catalogMessage(ERRORS.invalidAddress, { address }),
        address,
      );
    }
  });
});

describe("parseTypedData", () => {
  it("returns well-formed typed data unchanged", () => {
    assert.deepEqual(parseTypedData(EIP712_MAIL), EIP712_MAIL);
  });

  it("rejects payloads that are not EIP-712 typed data", () => {
    const notAnObject = catalogMessage(ERRORS.typedDataObject, {});
    const mailFields = catalogMessage(ERRORS.typedDataTypeFields, { typeName: "Mail" });
    const shape = catalogMessage(ERRORS.typedDataShape, {});
    const unknownType = { ...EIP712_MAIL, primaryType: "Missing" };
    // The encoder's own error, whose message the refusal passes on.
    const encoderError = (() => {
      try {
        typedDataDigest(unknownType);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    assert.ok(encoderError instanceof Error);
    const cases: Array<[string, unknown, string]> = [
      ["not an object", 42, notAnObject],
      ["an array", [], notAnObject],
      [
        "types not an object",
        { ...EIP712_MAIL, types: [] },
        catalogMessage(ERRORS.typedDataTypes, {}),
      ],
      ["fields not a list", { ...EIP712_MAIL, types: { Mail: {} } }, mailFields],
      // Each of these would reach the encoder, which fails on them with its own message.
      ["a field that is null", { ...EIP712_MAIL, types: { Mail: [null] } }, mailFields],
      [
        "a field without a name",
        { ...EIP712_MAIL, types: { Mail: [{ type: "string" }] } },
        mailFields,
      ],
      ["a field without a type", { ...EIP712_MAIL, types: { Mail: [{ name: "x" }] } }, mailFields],
      ["a missing primaryType", { ...EIP712_MAIL, primaryType: 1 }, shape],
      ["a missing domain", { ...EIP712_MAIL, domain: [] }, shape],
      ["a missing message", { ...EIP712_MAIL, message: null }, shape],
      [
        "an unknown primaryType",
        unknownType,
        catalogMessage(ERRORS.typedDataEncoder, { message: encoderError.message }),
      ],
    ];
    for (const [name, value, message] of cases) {
      assert.throws(() => parseTypedData(value), invalidTypedData(message), name);
    }
  });

  it("cuts the encoder's message, which quotes the value, to 200 characters ending in ...", () => {
    const typedData = {
      ...EIP712_MAIL,
      types: { ...EIP712_MAIL.types, Mail: [{ name: "contents", type: "string[]" }] },
      message: { contents: "x".repeat(10_000) },
    };
    const full = (() => {
      try {
        typedDataDigest(typedData);
      } catch (error) {
        return error instanceof Error ? error.message : undefined;
      }
      return undefined;
    })();
    assert.ok(full !== undefined && full.length > 200);
    // A message of exactly 200 characters is kept whole. The message ends with the value.
    assert.ok(full.endsWith("x".repeat(10_000)));
    const exact = { ...typedData, message: { contents: "x".repeat(10_000 - (full.length - 200)) } };
    assert.throws(
      () => parseTypedData(exact),
      invalidTypedData(catalogMessage(ERRORS.typedDataEncoder, { message: full.slice(0, 200) })),
    );
    assert.throws(
      () => parseTypedData(typedData),
      invalidTypedData(
        catalogMessage(ERRORS.typedDataEncoder, { message: `${full.slice(0, 197)}...` }),
      ),
    );
  });

  it("refuses values that are not plain data, before reading them", () => {
    const plainData = catalogMessage(ERRORS.typedDataPlainData, {});
    for (const [name, value] of [
      ["a function", { ...EIP712_MAIL, message: { ...EIP712_MAIL.message, hook: () => 1 } }],
      ["a symbol", { ...EIP712_MAIL, primaryType: Symbol("Mail") }],
    ] as const) {
      assert.throws(() => parseTypedData(value), invalidTypedData(plainData), name);
    }
  });

  it("keeps a type named __proto__ as data, not as the prototype", () => {
    const types: unknown = JSON.parse(
      '{"EIP712Domain":[],"__proto__":[{"name":"x","type":"uint256"}],"T":[{"name":"x","type":"uint256"}]}',
    );
    const parsed = parseTypedData({ types, primaryType: "T", domain: {}, message: { x: 1 } });
    assert.equal(Object.getPrototypeOf(parsed.types), Object.prototype);
    assert.ok(Object.hasOwn(parsed.types, "__proto__"));
  });
});
