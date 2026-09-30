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
  personalMessageDigest,
  typedDataDigest,
  verifyPersonalMessageSignature,
  verifyTypedDataSignature,
} from "../../../src/internal/crypto/digests.ts";
import { InvalidPublicKeyError } from "../../../src/internal/crypto/public-key.ts";
import { EIP712_MAIL } from "../../helpers/vectors.ts";

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
      assert.throws(() => toChecksumAddress(address), InvalidAddressError, address);
    }
  });
});
