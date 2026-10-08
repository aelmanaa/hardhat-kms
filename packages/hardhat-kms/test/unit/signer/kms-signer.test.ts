// Resizable ArrayBuffers (ES2024), which Node runs from 20 on; the shipped code targets ES2023.
/// <reference lib="es2024.arraybuffer" />

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HardhatPluginError } from "hardhat/plugins";
import { addr as microAddr } from "micro-eth-signer";

import type { TypedData } from "../../../src/internal/crypto/digests.ts";
import { recoverAddress, type SignatureOutput } from "../../../src/internal/crypto/signature.ts";
import { ERRORS } from "../../../src/internal/error-catalog.ts";
import {
  catalogError,
  catalogMessage,
  type ErrorEntry,
  type TemplateParams,
} from "../../../src/internal/errors.ts";
import { KmsSigner, type KmsSignerOptions } from "../../../src/internal/signer/kms-signer.ts";
import type { KmsKeyAdapter, SignContext } from "../../../src/internal/signer/types.ts";
import {
  addressOfSecretKey,
  fakeAdapter,
  type FakeAdapterOptions,
} from "../../helpers/fake-adapter.ts";
import { fakeTimers } from "../../helpers/fake-timers.ts";
import {
  COW_ACCOUNT,
  EIP712_MAIL,
  EIP712_MAIL_SIGNATURE,
  HARDHAT_ACCOUNT_0,
  PERSONAL_SIGN_VECTORS,
} from "../../helpers/vectors.ts";

const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
/** Replaced in a promise's executor before it is called. */
const ignore = (): void => undefined;
const baseOptions: KmsSignerOptions = {
  timeoutMs: 30_000,
  displayMessage: async () => {
    // Status lines are not under test here.
  },
};

function signer(adapterOptions: FakeAdapterOptions, options: Partial<KmsSignerOptions> = {}) {
  const adapter = fakeAdapter(adapterOptions);
  return { adapter, signer: new KmsSigner(adapter, { ...baseOptions, ...options }) };
}

async function assertPluginError(
  promise: Promise<unknown>,
  includes: string[],
  excludes: string[] = [],
) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(
      error instanceof HardhatPluginError,
      `expected HardhatPluginError, got ${String(error)}`,
    );
    for (const text of includes) {
      assert.ok(error.message.includes(text), `"${error.message}" should include "${text}"`);
    }
    for (const text of excludes) {
      assert.ok(!error.message.includes(text), `"${error.message}" must not include "${text}"`);
    }
    return true;
  });
}

/** The message of the catalogue error that the fake key's signer throws during `operation`. */
function fakeKeyMessage<Template extends string>(
  operation: string | undefined,
  entry: ErrorEntry<Template, "error">,
  params: TemplateParams<Template>,
  key = "fake-key-1",
): string {
  return catalogError(entry, params, { provider: "fake", operation, key }).message;
}

/** Asserts that `promise` rejects with a `HardhatPluginError` whose message is exactly `message`. */
async function rejectsWith(promise: Promise<unknown>, message: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(
      error instanceof HardhatPluginError,
      `expected HardhatPluginError, got ${String(error)}`,
    );
    assert.equal(error.message, message);
    return true;
  });
}

/** Asserts that `create` throws a `HardhatPluginError` whose message is exactly `message`. */
function throwsWith(create: () => unknown, message: string) {
  assert.throws(create, (error: unknown) => {
    assert.ok(
      error instanceof HardhatPluginError,
      `expected HardhatPluginError, got ${String(error)}`,
    );
    assert.equal(error.message, message);
    return true;
  });
}

/** The message of the signer's `core.signer.cancelled` error during `operation`. */
const cancelled = (operation: string): string =>
  fakeKeyMessage(operation, ERRORS.signerCancelled, {});

/** An adapter whose public key lookup answers when the test says so. */
function heldLookup() {
  const inner = fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) });
  let answer: () => void = ignore;
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const lookups: AbortSignal[] = [];
  const adapter: KmsKeyAdapter = {
    describe: () => inner.describe(),
    getPublicKey: async (ctx) => {
      lookups.push(ctx.signal);
      await answered;
      return await (inner.getPublicKey?.(ctx) ?? Promise.reject(new Error("missing")));
    },
    signDigest: async (request, ctx) =>
      await (inner.signDigest?.(request, ctx) ?? Promise.reject(new Error("missing"))),
  };
  return { kms: new KmsSigner(adapter, baseOptions), answer, lookups };
}

describe("KmsSigner", () => {
  describe("byte equivalence with Hardhat's local accounts", () => {
    for (const format of ["der", "compact", "rs"] as const) {
      for (const highS of [false, true]) {
        it(`signs the EIP-712 example exactly like Hardhat (${format}, high-S ${String(highS)})`, async () => {
          const { signer: kms } = signer({ secretKey: hex(COW_ACCOUNT.secretKey), format, highS });

          assert.equal(await kms.signTypedData(EIP712_MAIL), EIP712_MAIL_SIGNATURE);
        });
      }
    }

    for (const vector of PERSONAL_SIGN_VECTORS) {
      it(`signs personal_sign exactly like Hardhat (${vector.source} vector)`, async () => {
        const { signer: kms } = signer({
          secretKey: hex(HARDHAT_ACCOUNT_0.secretKey),
          highS: true,
        });

        assert.equal(await kms.signPersonalMessage(hex(vector.message)), vector.signature);
      });
    }
  });

  describe("key identity", () => {
    it("derives the address from the public key and fetches it once", async () => {
      const { adapter, signer: kms } = signer({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) });

      assert.equal(await kms.getAddress(), HARDHAT_ACCOUNT_0.address);
      await kms.signDigest(new Uint8Array(32).fill(1));
      await kms.signDigest(new Uint8Array(32).fill(2));
      assert.equal(adapter.calls.getPublicKey, 1);
    });

    it("returns the public key, fetched once, as a copy the caller cannot change", async () => {
      const secretKey = hex(HARDHAT_ACCOUNT_0.secretKey);
      const { adapter, signer: kms } = signer({ secretKey });
      const expected = secp256k1.getPublicKey(secretKey, false);

      const first = await kms.getPublicKey();
      first.fill(0);

      assert.deepEqual(await kms.getPublicKey(), expected);
      assert.equal(await kms.getAddress(), HARDHAT_ACCOUNT_0.address);
      assert.equal(adapter.calls.getPublicKey, 1);
    });

    describe("keeps its own copy of the provider's public key", () => {
      const secretKey = hex(HARDHAT_ACCOUNT_0.secretKey);
      const expected = secp256k1.getPublicKey(secretKey, false);

      /**
       * A signer whose adapter returns `held` as the public key and signs with the key
       * `signingKey()` returns, so a test can change both after the signer checked the key.
       */
      function holdingSigner(held: Uint8Array, signingKey: () => Uint8Array = () => secretKey) {
        const adapter: KmsKeyAdapter = {
          describe: () => fakeAdapter({ secretKey }).describe(),
          getPublicKey: async () => await Promise.resolve(held),
          signDigest: async (request, ctx) =>
            await (fakeAdapter({ secretKey: signingKey() }).signDigest?.(request, ctx) ??
              Promise.reject(new Error("missing"))),
        };
        return new KmsSigner(adapter, baseOptions);
      }

      it("checks later signatures against the original key after the adapter changes it", async () => {
        const held = new Uint8Array(expected);
        const otherKey = hex(COW_ACCOUNT.secretKey);
        let signingKey = secretKey;
        const kms = holdingSigner(held, () => signingKey);
        await kms.signDigest(new Uint8Array(32).fill(1));

        // The adapter swaps another valid key into the array it returned, and signs with it.
        held.set(secp256k1.getPublicKey(otherKey, false));
        signingKey = otherKey;
        await assertPluginError(kms.signDigest(new Uint8Array(32).fill(2)), [
          "fake, sign",
          "invalid signature",
        ]);

        // Signing with the original key still verifies.
        signingKey = secretKey;
        const digest = new Uint8Array(32).fill(3);
        assert.equal(
          recoverAddress(digest, await kms.signDigest(digest)),
          HARDHAT_ACCOUNT_0.address,
        );
        assert.deepEqual(await kms.getPublicKey(), expected);
      });

      it("keeps signing after the adapter zeroes the Buffer it returned", async () => {
        const held = Buffer.from(expected);
        const kms = holdingSigner(held);
        await kms.signDigest(new Uint8Array(32).fill(1));

        held.fill(0);
        await kms.signDigest(new Uint8Array(32).fill(2));
        assert.deepEqual(await kms.getPublicKey(), expected);
      });

      it("keeps signing after the adapter shrinks the resizable buffer it returned", async () => {
        const buffer = new ArrayBuffer(expected.length, { maxByteLength: expected.length });
        // A length-tracking view: it shrinks with its buffer.
        const held = new Uint8Array(buffer);
        held.set(expected);
        const kms = holdingSigner(held);
        await kms.signDigest(new Uint8Array(32).fill(1));

        buffer.resize(0);
        assert.equal(held.length, 0);
        await kms.signDigest(new Uint8Array(32).fill(2));
        assert.deepEqual(await kms.getPublicKey(), expected);
      });

      it("returns copies the caller cannot use to change the key, when the adapter returned a Buffer", async () => {
        const kms = holdingSigner(Buffer.from(expected));

        // Before the copy, the signer kept the adapter's Buffer, and `.slice()` of a Buffer is a
        // view of the same memory.
        (await kms.getPublicKey()).fill(0);
        await kms.signDigest(new Uint8Array(32).fill(1));
        assert.deepEqual(await kms.getPublicKey(), expected);
      });

      it("checks the bytes it keeps, not a first read that differs from them", async () => {
        // On the curve's x-axis prefix but not a point on secp256k1.
        const offCurve = new Uint8Array(expected.length);
        offCurve[0] = 0x04;
        // Indexed reads and methods see the valid key; iterating, as a copy does, sees the other.
        const twoFaced = new Proxy(new Uint8Array(expected), {
          get(target, property) {
            if (property === Symbol.iterator) {
              return () => offCurve[Symbol.iterator]();
            }
            const value: unknown = Reflect.get(target, property, target);
            if (typeof value !== "function") {
              return value;
            }
            return (...args: unknown[]): unknown => Reflect.apply(value, target, args);
          },
        });
        assert.ok(twoFaced instanceof Uint8Array);

        await assertPluginError(holdingSigner(twoFaced).getAddress(), [
          "fake, get public key",
          "the public key is not a point on secp256k1",
        ]);
      });

      it("reports a value that is not a byte array as a wrong key", async () => {
        const adapter = fakeAdapter({ secretKey });
        // A third-party adapter written in JavaScript can break the contract's types.
        Reflect.set(adapter, "getPublicKey", async () => await Promise.resolve(undefined));

        await assertPluginError(new KmsSigner(adapter, baseOptions).getAddress(), [
          "fake, get public key",
          "expected a 65-byte uncompressed public key",
        ]);
      });
    });

    it("has a public key for an address-only key only once it has signed", async () => {
      const { signer: kms } = signer({
        secretKey: hex(HARDHAT_ACCOUNT_0.secretKey),
        identity: "address",
      });

      await assertPluginError(kms.getPublicKey(), [
        "fake, get public key",
        "the provider returns only the key's address, not its public key",
      ]);
      await kms.signDigest(new Uint8Array(32).fill(1));
      assert.deepEqual(
        await kms.getPublicKey(),
        secp256k1.getPublicKey(hex(HARDHAT_ACCOUNT_0.secretKey), false),
      );
    });

    it("accepts a matching address pin in any case", async () => {
      const { signer: kms } = signer(
        { secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) },
        { expectedAddress: HARDHAT_ACCOUNT_0.address.toLowerCase() },
      );

      assert.equal(await kms.getAddress(), HARDHAT_ACCOUNT_0.address);
    });

    it("refuses to sign when the key does not match the address pin", async () => {
      const other = "0x0000000000000000000000000000000000000001";
      const { adapter, signer: kms } = signer(
        { secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) },
        { expectedAddress: other },
      );

      await rejectsWith(
        kms.signDigest(new Uint8Array(32)),
        fakeKeyMessage("check address", ERRORS.addressMismatch, {
          address: HARDHAT_ACCOUNT_0.address,
          expected: other,
        }),
      );
      assert.equal(adapter.calls.signDigest, 0);
    });

    it("explains a pin mismatch without telling the user to change the pin", async () => {
      const other = "0x0000000000000000000000000000000000000001";
      const { signer: kms } = signer(
        { secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) },
        { expectedAddress: other },
      );

      // The literal text, so a reword back to "update the configuration" fails here.
      await rejectsWith(
        kms.signDigest(new Uint8Array(32)),
        `fake, check address, key fake-key-1: the key derives to ${HARDHAT_ACCOUNT_0.address}, but the configured address is ${other}, so nothing was signed. The key id may now name the wrong key or a substituted one, or the pin may be wrong. Do not change the pin to match until you know why the key changed; see "When the pin fails" in the key rotation guide, which also covers a deliberate move to a new key.`,
      );
      assert.equal(ERRORS.addressMismatch.id, "core.signer.address-mismatch");
    });

    it("checks address-only keys against the pin on the first signature", async () => {
      const secretKey = hex(HARDHAT_ACCOUNT_0.secretKey);
      const pinned = new KmsSigner(fakeAdapter({ secretKey, identity: "none" }), {
        ...baseOptions,
        expectedAddress: HARDHAT_ACCOUNT_0.address,
      });
      const wrongPin = new KmsSigner(fakeAdapter({ secretKey, identity: "none" }), {
        ...baseOptions,
        expectedAddress: addressOfSecretKey(secp256k1.utils.randomSecretKey()),
      });

      assert.equal(
        await pinned.signPersonalMessage(hex(PERSONAL_SIGN_VECTORS[0].message)),
        PERSONAL_SIGN_VECTORS[0].signature,
      );
      await assertPluginError(wrongPin.signDigest(new Uint8Array(32).fill(3)), [
        "invalid signature",
      ]);
    });

    it("uses getAddress when the provider has no public key call", async () => {
      const { adapter, signer: kms } = signer({
        secretKey: hex(HARDHAT_ACCOUNT_0.secretKey),
        identity: "address",
      });

      assert.equal(await kms.getAddress(), HARDHAT_ACCOUNT_0.address);
      await kms.signDigest(new Uint8Array(32).fill(4));
      assert.equal(adapter.calls.getAddress, 1);
    });

    it("normalizes an all-uppercase pin, so message signing verifies on address-only keys", async () => {
      const upper = `0x${HARDHAT_ACCOUNT_0.address.slice(2).toUpperCase()}`;
      const kms = new KmsSigner(
        fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey), identity: "none" }),
        { ...baseOptions, expectedAddress: upper },
      );

      assert.equal(await kms.getAddress(), HARDHAT_ACCOUNT_0.address);
      assert.equal(
        await kms.signPersonalMessage(hex(PERSONAL_SIGN_VECTORS[0].message)),
        PERSONAL_SIGN_VECTORS[0].signature,
      );
    });

    it("rejects a malformed pin or one with a wrong checksum", () => {
      const secretKey = hex(HARDHAT_ACCOUNT_0.secretKey);
      // The first two letters have their case swapped.
      const wrongChecksum = "0xF39fd6e51aad88F6F4ce6aB8827279cffFb92266";
      for (const expectedAddress of [
        "0x1234",
        "f39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        wrongChecksum,
      ]) {
        throwsWith(
          () => new KmsSigner(fakeAdapter({ secretKey }), { ...baseOptions, expectedAddress }),
          fakeKeyMessage(undefined, ERRORS.signerAddressInvalid, {
            reason: catalogMessage(ERRORS.invalidAddress, { address: expectedAddress }),
          }),
        );
      }
    });

    it("names the key by the configured display id in errors from the constructor", () => {
      throwsWith(
        () =>
          new KmsSigner(fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) }), {
            ...baseOptions,
            expectedAddress: "0x1234",
            displayId: "configured-key",
          }),
        fakeKeyMessage(
          undefined,
          ERRORS.signerAddressInvalid,
          { reason: catalogMessage(ERRORS.invalidAddress, { address: "0x1234" }) },
          "configured-key",
        ),
      );
    });

    it("passes through an error that is not an invalid address", () => {
      const options: KmsSignerOptions = { ...baseOptions };
      // A JavaScript caller can break the option's type; the regex test cannot read a symbol.
      Reflect.set(options, "expectedAddress", Symbol("pin"));

      assert.throws(
        () => new KmsSigner(fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) }), options),
        TypeError,
      );
    });

    it("checksums the address returned by address-only providers and rejects garbage", async () => {
      const inner = fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) });
      const lower = new KmsSigner(
        {
          describe: () => inner.describe(),
          getAddress: async () => await Promise.resolve(HARDHAT_ACCOUNT_0.address.toLowerCase()),
        },
        baseOptions,
      );
      const garbage = new KmsSigner(
        {
          describe: () => inner.describe(),
          getAddress: async () => await Promise.resolve("not-an-address"),
        },
        baseOptions,
      );

      assert.equal(await lower.getAddress(), HARDHAT_ACCOUNT_0.address);
      await assertPluginError(garbage.getAddress(), [
        "get address",
        "not-an-address is not a valid",
      ]);
    });

    it("reports an invalid public key from the provider with its reason", async () => {
      const inner = fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) });
      const kms = new KmsSigner(
        {
          describe: () => inner.describe(),
          getPublicKey: async () => await Promise.resolve(new Uint8Array(65).fill(4)),
        },
        baseOptions,
      );

      await assertPluginError(kms.getAddress(), ["get public key", "fake-key-1"]);
    });

    it("rejects timeouts Node cannot schedule", () => {
      const secretKey = hex(HARDHAT_ACCOUNT_0.secretKey);
      for (const timeoutMs of [0, -1, 1.5, Number.NaN, 2 ** 31]) {
        throwsWith(
          () => new KmsSigner(fakeAdapter({ secretKey }), { ...baseOptions, timeoutMs }),
          fakeKeyMessage(undefined, ERRORS.signerTimeoutRange, { timeout: timeoutMs }),
        );
      }
    });

    it("accepts the shortest and the longest timeout Node can schedule", async () => {
      const secretKey = hex(HARDHAT_ACCOUNT_0.secretKey);
      for (const timeoutMs of [1, 2 ** 31 - 1]) {
        const timers = fakeTimers();
        const kms = new KmsSigner(fakeAdapter({ secretKey }), {
          ...baseOptions,
          timeoutMs,
          timers,
        });

        assert.equal(await kms.getAddress(), HARDHAT_ACCOUNT_0.address);
      }
    });

    it("requires a way to identify the key", () => {
      throwsWith(
        () =>
          new KmsSigner(
            fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey), identity: "none" }),
            baseOptions,
          ),
        fakeKeyMessage(undefined, ERRORS.signerNoIdentity, {}),
      );
    });

    it("fails clearly when the adapter drops its only identity call after the check", async () => {
      // A third-party adapter is a mutable object: the constructor saw getAddress, the first
      // lookup does not.
      const adapter = fakeAdapter({
        secretKey: hex(HARDHAT_ACCOUNT_0.secretKey),
        identity: "address",
      });
      const kms = new KmsSigner(adapter, baseOptions);
      Reflect.deleteProperty(adapter, "getAddress");

      await rejectsWith(
        kms.getAddress(),
        fakeKeyMessage("get address", ERRORS.signerCannotIdentify, {}),
      );
    });

    it("describes the key as the adapter did when the signer was created", () => {
      const adapter = fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) });
      const kms = new KmsSigner(adapter, baseOptions);

      assert.deepEqual(kms.describe(), adapter.describe());
      assert.ok(Object.isFrozen(kms.describe()));
    });

    it("shares one key lookup between concurrent first calls", async () => {
      const { adapter, signer: kms } = signer({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) });

      const [a, b] = await Promise.all([kms.getAddress(), kms.getAddress()]);
      assert.equal(a, HARDHAT_ACCOUNT_0.address);
      assert.equal(b, HARDHAT_ACCOUNT_0.address);
      assert.equal(adapter.calls.getPublicKey, 1);
    });

    it("rejects a compressed public key from the provider", async () => {
      const inner = fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) });
      const kms = new KmsSigner(
        {
          describe: () => inner.describe(),
          getPublicKey: async () =>
            await Promise.resolve(secp256k1.getPublicKey(hex(HARDHAT_ACCOUNT_0.secretKey), true)),
        },
        baseOptions,
      );

      await assertPluginError(kms.getAddress(), ["get public key", "65-byte uncompressed"]);
    });

    it("does not cache a failed key lookup", async () => {
      const secretKey = hex(HARDHAT_ACCOUNT_0.secretKey);
      let fail = true;
      const inner = fakeAdapter({ secretKey });
      const adapter: KmsKeyAdapter = {
        ...inner,
        getPublicKey: async (ctx) => {
          if (fail) {
            throw new Error("network down");
          }
          return await (inner.getPublicKey?.(ctx) ?? Promise.reject(new Error("missing")));
        },
      };
      const kms = new KmsSigner(adapter, baseOptions);

      await assertPluginError(kms.getAddress(), ["get public key"]);
      fail = false;
      assert.equal(await kms.getAddress(), HARDHAT_ACCOUNT_0.address);
    });
  });

  describe("signature checks", () => {
    it("refuses r and s that are numbers with its own error, after one fresh request", async () => {
      // A third-party adapter in plain JavaScript; s is above n/2, so it would be folded.
      const half = Number(secp256k1.Point.CURVE().n / 2n);
      for (const [r, s] of [
        [1e77, half * 1.5],
        [1n, half * 1.5],
        [1e77, 1n],
      ]) {
        const { adapter } = signer({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) });
        let calls = 0;
        Reflect.set(adapter, "signDigest", async () => {
          calls++;
          return await Promise.resolve({ r, s });
        });
        const kms = new KmsSigner(adapter, baseOptions);

        await rejectsWith(
          kms.signDigest(new Uint8Array(32).fill(5)),
          fakeKeyMessage("sign", ERRORS.signerInvalidSignature, {
            reason: catalogMessage(ERRORS.signatureScalarType, {}),
          }),
        );
        assert.equal(calls, 2);
      }
    });

    it("asks for one fresh signature when the first does not match the key", async () => {
      const { adapter, signer: kms } = signer({
        secretKey: hex(HARDHAT_ACCOUNT_0.secretKey),
        wrongKeyForCalls: 1,
      });

      const digest = new Uint8Array(32).fill(5);
      const expected = secp256k1.sign(digest, hex(HARDHAT_ACCOUNT_0.secretKey), {
        prehash: false,
        lowS: true,
        format: "recovered",
      });
      const expectedSignature = secp256k1.Signature.fromBytes(expected.slice(1), "compact");

      assert.deepEqual(await kms.signDigest(digest), {
        r: expectedSignature.r,
        s: expectedSignature.s,
        yParity: expected[0],
      });
      assert.equal(adapter.calls.signDigest, 2);
    });

    it("fails when the provider keeps signing with another key", async () => {
      const { adapter, signer: kms } = signer({
        secretKey: hex(HARDHAT_ACCOUNT_0.secretKey),
        signWithSecretKey: secp256k1.utils.randomSecretKey(),
      });

      // The reason is the public key check's: a key known from the provider is compared as a
      // key, not through its address.
      await rejectsWith(
        kms.signDigest(new Uint8Array(32).fill(6)),
        fakeKeyMessage("sign", ERRORS.signerInvalidSignature, {
          reason: catalogMessage(ERRORS.signatureNoRecovery, {}),
        }),
      );
      assert.equal(adapter.calls.signDigest, 2);
    });

    it("fails when native typed-data or message signing uses another key", async () => {
      const inner = fakeAdapter({
        secretKey: hex(COW_ACCOUNT.secretKey),
        signWithSecretKey: secp256k1.utils.randomSecretKey(),
      });
      let calls = 0;
      const adapter: KmsKeyAdapter = {
        describe: () => inner.describe(),
        getPublicKey: async (ctx) =>
          await (inner.getPublicKey?.(ctx) ?? Promise.reject(new Error("missing"))),
        signTypedData: async ({ digest }, ctx) => {
          calls++;
          return await (inner.signDigest?.({ digest }, ctx) ??
            Promise.reject(new Error("missing")));
        },
        signMessage: async ({ digest }, ctx) => {
          calls++;
          return await (inner.signDigest?.({ digest }, ctx) ??
            Promise.reject(new Error("missing")));
        },
      };
      const kms = new KmsSigner(adapter, baseOptions);

      await assertPluginError(kms.signTypedData(EIP712_MAIL), ["invalid signature"]);
      await assertPluginError(kms.signPersonalMessage(Uint8Array.of(1)), ["invalid signature"]);
      assert.equal(calls, 4);
    });

    it("fails when an address-only provider reports an address its key does not have", async () => {
      const inner = fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) });
      let signCalls = 0;
      const adapter: KmsKeyAdapter = {
        describe: () => inner.describe(),
        getAddress: async () => await Promise.resolve(COW_ACCOUNT.address),
        signDigest: async (request, ctx) => {
          signCalls++;
          return await (inner.signDigest?.(request, ctx) ?? Promise.reject(new Error("missing")));
        },
      };

      await rejectsWith(
        new KmsSigner(adapter, baseOptions).signDigest(new Uint8Array(32).fill(8)),
        fakeKeyMessage("sign", ERRORS.signerInvalidSignature, {
          reason: catalogMessage(ERRORS.signatureNotConfiguredAddress, {}),
        }),
      );
      assert.equal(signCalls, 2);
    });

    it("fails clearly when the provider has no way to sign", async () => {
      const inner = fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) });
      const adapter: KmsKeyAdapter = {
        describe: () => inner.describe(),
        getPublicKey: async (ctx) =>
          await (inner.getPublicKey?.(ctx) ?? Promise.reject(new Error("missing"))),
      };

      const kms = new KmsSigner(adapter, baseOptions);

      await rejectsWith(
        kms.signDigest(new Uint8Array(32)),
        fakeKeyMessage("sign", ERRORS.signerCannotSign, { kind: "digest" }),
      );
      await rejectsWith(
        kms.signPersonalMessage(Uint8Array.of(1)),
        fakeKeyMessage("sign", ERRORS.signerCannotSign, { kind: "personal message" }),
      );
      await rejectsWith(
        kms.signTypedData(EIP712_MAIL),
        fakeKeyMessage("sign", ERRORS.signerCannotSign, { kind: "typed-data payload" }),
      );
    });

    it("skips a recovery bit that gives no key, for an address-only key", async () => {
      // r = Gx, s = e: candidate R = G (bit 0, G's y is even) gives the point at infinity;
      // R = -G (bit 1, nonce n - 1) gives the key the signature is valid for, which is the key
      // the provider's address belongs to.
      const digest = new Uint8Array(32).fill(7);
      const r = secp256k1.Point.BASE.x;
      const s = BigInt(`0x${Buffer.from(digest).toString("hex")}`);
      assert.throws(() => new secp256k1.Signature(r, s).addRecoveryBit(0).recoverPublicKey(digest));
      const publicKey = new secp256k1.Signature(r, s)
        .addRecoveryBit(1)
        .recoverPublicKey(digest)
        .toBytes(false);
      const adapter: KmsKeyAdapter = {
        describe: () => fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) }).describe(),
        getAddress: async () => await Promise.resolve(microAddr.fromPublicKey(publicKey)),
        signDigest: async () => await Promise.resolve({ r, s }),
      };
      const kms = new KmsSigner(adapter, baseOptions);

      assert.deepEqual(await kms.signDigest(digest), { r, s, yParity: 1 });
      assert.deepEqual(await kms.getPublicKey(), publicKey);
    });
  });

  describe("caller errors", () => {
    it("rejects a digest that is not 32 bytes before calling the provider", async () => {
      const { adapter, signer: kms } = signer({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) });

      await rejectsWith(
        kms.signDigest(new Uint8Array(31)),
        fakeKeyMessage("sign", ERRORS.signerDigestLength, { expected: 32, length: 31 }),
      );
      assert.equal(adapter.calls.signDigest, 0);
    });
  });

  describe("hands the provider copies of what it signs", () => {
    const secretKey = hex(COW_ACCOUNT.secretKey);

    /** An adapter that signs digests with `sign`, through each of the three adapter methods. */
    function copyingAdapter(
      sign: (digest: Uint8Array, ctx: SignContext, method: string) => Promise<SignatureOutput>,
      hooks: { message?: (message: Uint8Array) => void; typedData?: (data: TypedData) => void },
    ) {
      const inner = fakeAdapter({ secretKey });
      const adapter: KmsKeyAdapter = {
        describe: () => inner.describe(),
        getPublicKey: async (ctx) =>
          await (inner.getPublicKey?.(ctx) ?? Promise.reject(new Error("missing"))),
        signDigest: async ({ digest }, ctx) => await sign(digest, ctx, "signDigest"),
        signMessage: async ({ message, digest }, ctx) => {
          hooks.message?.(message);
          return await sign(digest, ctx, "signMessage");
        },
        signTypedData: async ({ typedData, digest }, ctx) => {
          hooks.typedData?.(typedData);
          return await sign(digest, ctx, "signTypedData");
        },
      };
      return { inner, kms: new KmsSigner(adapter, baseOptions) };
    }

    it("refuses a signature over a digest the provider overwrote, on every signing path", async () => {
      const methods: string[] = [];
      const { inner, kms } = copyingAdapter(async (digest, ctx, method) => {
        methods.push(method);
        // The adapter overwrites the digest it received, then signs the overwritten one.
        digest.fill(9);
        return await (inner.signDigest?.({ digest }, ctx) ?? Promise.reject(new Error("missing")));
      }, {});
      const expected = ["fake, sign", "the provider returned an invalid signature"];

      const digest = new Uint8Array(32).fill(1);
      await assertPluginError(kms.signDigest(digest), expected);
      assert.deepEqual(digest, new Uint8Array(32).fill(1));
      await assertPluginError(kms.signPersonalMessage(Uint8Array.of(1, 2, 3)), expected);
      await assertPluginError(kms.signTypedData(structuredClone(EIP712_MAIL)), expected);
      // Each request goes to its own adapter method, once and then for the one retry.
      assert.deepEqual(methods, [
        "signDigest",
        "signDigest",
        "signMessage",
        "signMessage",
        "signTypedData",
        "signTypedData",
      ]);
    });

    it("keeps the caller's message and typed data when the provider changes its copies", async () => {
      const { inner, kms } = copyingAdapter(
        async (digest, ctx) =>
          await (inner.signDigest?.({ digest }, ctx) ?? Promise.reject(new Error("missing"))),
        {
          message: (message) => {
            message.fill(0);
          },
          typedData: (typedData) => {
            typedData.message["contents"] = "Changed by the provider";
          },
        },
      );

      const message = Uint8Array.of(1, 2, 3);
      await kms.signPersonalMessage(message);
      assert.deepEqual(message, Uint8Array.of(1, 2, 3));

      const typedData = structuredClone(EIP712_MAIL);
      assert.equal(await kms.signTypedData(typedData), EIP712_MAIL_SIGNATURE);
      assert.deepEqual(typedData, EIP712_MAIL);
    });

    it("refuses typed data it cannot copy before calling the provider", async () => {
      const methods: string[] = [];
      const { inner, kms } = copyingAdapter(async (digest, ctx, method) => {
        methods.push(method);
        return await (inner.signDigest?.({ digest }, ctx) ?? Promise.reject(new Error("missing")));
      }, {});
      // The digest reads the message through the proxy, but structuredClone cannot copy a proxy.
      const typedData = { ...EIP712_MAIL, message: new Proxy(EIP712_MAIL.message, {}) };

      await assertPluginError(kms.signTypedData(typedData), [
        "fake, sign",
        "the typed data is invalid: the typed data must be plain data",
      ]);
      assert.deepEqual(methods, []);
    });
  });

  describe("provider-native signing", () => {
    it("hands typed data and messages to adapters that sign them natively", async () => {
      const inner = fakeAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) });
      const seen: string[] = [];
      const adapter: KmsKeyAdapter = {
        describe: () => inner.describe(),
        getPublicKey: async (ctx) =>
          await (inner.getPublicKey?.(ctx) ?? Promise.reject(new Error("missing"))),
        signTypedData: async ({ typedData, digest }, ctx) => {
          seen.push(`typedData:${typedData.primaryType}`);
          return await (inner.signDigest?.({ digest }, ctx) ??
            Promise.reject(new Error("missing")));
        },
        signMessage: async ({ message, digest }, ctx) => {
          seen.push(`message:${message.length}`);
          return await (inner.signDigest?.({ digest }, ctx) ??
            Promise.reject(new Error("missing")));
        },
      };
      const kms = new KmsSigner(adapter, baseOptions);

      assert.equal(await kms.signTypedData(EIP712_MAIL), EIP712_MAIL_SIGNATURE);
      await kms.signPersonalMessage(Uint8Array.of(1, 2, 3));
      assert.deepEqual(seen, ["typedData:Mail", "message:3"]);
    });

    it("forwards provider status lines to the user", async () => {
      const inner = fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) });
      const shown: string[] = [];
      const adapter: KmsKeyAdapter = {
        describe: () => inner.describe(),
        getPublicKey: async (ctx) => {
          await ctx.displayMessage("waiting for approval");
          return await (inner.getPublicKey?.(ctx) ?? Promise.reject(new Error("missing")));
        },
      };
      const kms = new KmsSigner(adapter, {
        ...baseOptions,
        displayMessage: async (message) => {
          shown.push(message);
        },
      });

      await kms.getAddress();
      assert.deepEqual(shown, ["waiting for approval"]);
    });
  });

  describe("provider failures", () => {
    it("reports a provider error raised while retrying", async () => {
      const inner = fakeAdapter({
        secretKey: hex(HARDHAT_ACCOUNT_0.secretKey),
        wrongKeyForCalls: 1,
      });
      let calls = 0;
      const adapter: KmsKeyAdapter = {
        describe: () => inner.describe(),
        getPublicKey: async (ctx) =>
          await (inner.getPublicKey?.(ctx) ?? Promise.reject(new Error("missing"))),
        signDigest: async (request, ctx) => {
          calls++;
          if (calls === 2) {
            throw new RangeError("throttled");
          }
          return await (inner.signDigest?.(request, ctx) ?? Promise.reject(new Error("missing")));
        },
      };

      await rejectsWith(
        new KmsSigner(adapter, baseOptions).signDigest(new Uint8Array(32).fill(7)),
        fakeKeyMessage("sign", ERRORS.signerCallFailed, { errorName: "RangeError" }),
      );
      assert.equal(calls, 2);
    });

    it("does not retry a provider error on the first attempt", async () => {
      const inner = fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) });
      let calls = 0;
      const adapter: KmsKeyAdapter = {
        describe: () => inner.describe(),
        getPublicKey: async (ctx) =>
          await (inner.getPublicKey?.(ctx) ?? Promise.reject(new Error("missing"))),
        signDigest: async (request, ctx) => {
          calls++;
          if (calls === 1) {
            throw new RangeError("throttled");
          }
          return await (inner.signDigest?.(request, ctx) ?? Promise.reject(new Error("missing")));
        },
      };

      await rejectsWith(
        new KmsSigner(adapter, baseOptions).signDigest(new Uint8Array(32).fill(7)),
        fakeKeyMessage("sign", ERRORS.signerCallFailed, { errorName: "RangeError" }),
      );
      assert.equal(calls, 1);
    });

    it("does not retry a signing call that timed out", async () => {
      const timers = fakeTimers();
      const inner = fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) });
      let calls = 0;
      const adapter: KmsKeyAdapter = {
        describe: () => inner.describe(),
        getPublicKey: async (ctx) =>
          await (inner.getPublicKey?.(ctx) ?? Promise.reject(new Error("missing"))),
        signDigest: async () => {
          calls++;
          return await new Promise<never>(() => {
            // Never answers.
          });
        },
      };
      const kms = new KmsSigner(adapter, { ...baseOptions, timers, timeoutMs: 1234 });
      await kms.getAddress();

      const pending = kms.signDigest(new Uint8Array(32).fill(7));
      await new Promise((resolve) => setImmediate(resolve));
      timers.fire();
      await rejectsWith(pending, fakeKeyMessage("sign", ERRORS.signerNoAnswer, { timeout: 1234 }));
      assert.equal(calls, 1);
      assert.equal(timers.pending(), 0);
    });

    it("times out and aborts the call", async () => {
      const timers = fakeTimers();
      const inner = fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) });
      let signal: AbortSignal | undefined;
      const adapter: KmsKeyAdapter = {
        describe: () => inner.describe(),
        getPublicKey: async (ctx) => {
          signal = ctx.signal;
          return await new Promise<never>(() => {
            // Never answers.
          });
        },
      };
      const kms = new KmsSigner(adapter, { ...baseOptions, timers, timeoutMs: 1234 });

      const pending = kms.getAddress();
      await Promise.resolve();
      assert.equal(timers.pending(), 1);
      timers.fire();
      await assertPluginError(pending, ["no answer within 1234 ms"]);
      assert.equal(signal?.aborted, true);
      assert.equal(timers.pending(), 0);
    });

    it("passes plugin and signature errors raised by the adapter through unchanged", async () => {
      const inner = fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) });
      const pluginError = new HardhatPluginError("hardhat-kms", "adapter says no");
      const kms = new KmsSigner(
        {
          describe: () => inner.describe(),
          getPublicKey: async () => await Promise.reject(pluginError),
        },
        baseOptions,
      );

      await assert.rejects(kms.getAddress(), (error: unknown) => error === pluginError);
    });

    it("never leaks the provider's error text", async () => {
      const secret = "Bearer eyJhbGciOiJSUzI1NiJ9.secret-token";
      const { signer: kms } = signer({
        secretKey: hex(HARDHAT_ACCOUNT_0.secretKey),
        throwError: new TypeError(secret),
      });

      await assertPluginError(kms.getAddress(), ["TypeError", "fake"], [secret, "secret-token"]);
    });

    it("drops provider error names that do not look like class names", async () => {
      const error = new Error("x");
      error.name = "Unauthorized: token=abc123";
      const { signer: kms } = signer({
        secretKey: hex(HARDHAT_ACCOUNT_0.secretKey),
        throwError: error,
      });

      await assertPluginError(kms.getAddress(), ["(Error)"], ["abc123"]);
    });

    it("closes an adapter that has nothing to close", async () => {
      const adapter = fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) });
      assert.ok(!("close" in adapter));

      await new KmsSigner(adapter, baseOptions).close();
    });

    it("closes the adapter", async () => {
      let closed = false;
      const adapter: KmsKeyAdapter = {
        ...fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) }),
        close: async () => {
          closed = true;
        },
      };

      await new KmsSigner(adapter, baseOptions).close();
      assert.ok(closed);
    });
  });

  describe("final checks of messages and typed data", () => {
    it("refuses a personal-message signature when the caller changed the message while signing", async () => {
      const message = Uint8Array.of(1, 2, 3);
      const { signer: kms } = signer({
        secretKey: hex(HARDHAT_ACCOUNT_0.secretKey),
        beforeSign: async () => {
          message[0] = 9;
          await Promise.resolve();
        },
      });

      await rejectsWith(
        kms.signPersonalMessage(message),
        fakeKeyMessage("sign message", ERRORS.signerEip191Failed, {}),
      );
    });

    it("refuses a typed-data signature when the caller changed the data while signing", async () => {
      const typedData = structuredClone(EIP712_MAIL);
      const { signer: kms } = signer({
        secretKey: hex(COW_ACCOUNT.secretKey),
        beforeSign: async () => {
          typedData.message["contents"] = "Changed by the caller";
          await Promise.resolve();
        },
      });

      await rejectsWith(
        kms.signTypedData(typedData),
        fakeKeyMessage("sign typed data", ERRORS.signerEip712Failed, {}),
      );
    });
  });

  describe("confirmedAddress", () => {
    const secretKey = hex(HARDHAT_ACCOUNT_0.secretKey);

    it("confirms the address derived from the public key, pinned or not", async () => {
      for (const expectedAddress of [undefined, HARDHAT_ACCOUNT_0.address]) {
        const { adapter, signer: kms } = signer({ secretKey }, { expectedAddress });

        assert.deepEqual(await kms.confirmedAddress(), {
          address: HARDHAT_ACCOUNT_0.address,
          confirmed: true,
        });
        assert.equal(adapter.calls.getPublicKey, 1);
      }
    });

    it("asks an address-only provider without a pin once, and keeps the answer", async () => {
      const { adapter, signer: kms } = signer({ secretKey, identity: "address" });

      assert.deepEqual(await kms.confirmedAddress(), {
        address: HARDHAT_ACCOUNT_0.address,
        confirmed: true,
      });
      assert.equal(await kms.getAddress(), HARDHAT_ACCOUNT_0.address);
      assert.equal(adapter.calls.getAddress, 1);
    });

    it("asks an address-only provider with a pin each time, and checks the answer", async () => {
      const { adapter, signer: kms } = signer(
        { secretKey, identity: "address" },
        { expectedAddress: HARDHAT_ACCOUNT_0.address.toLowerCase() },
      );

      assert.deepEqual(await kms.confirmedAddress(), {
        address: HARDHAT_ACCOUNT_0.address,
        confirmed: true,
      });
      assert.deepEqual(await kms.confirmedAddress(), {
        address: HARDHAT_ACCOUNT_0.address,
        confirmed: true,
      });
      assert.equal(adapter.calls.getAddress, 2);
    });

    it("refuses an address-only provider's address that differs from the pin", async () => {
      const { signer: kms } = signer(
        { secretKey, identity: "address" },
        { expectedAddress: COW_ACCOUNT.address },
      );

      await rejectsWith(
        kms.confirmedAddress(),
        fakeKeyMessage("check address", ERRORS.addressMismatch, {
          address: HARDHAT_ACCOUNT_0.address,
          expected: COW_ACCOUNT.address,
        }),
      );
    });

    it("names the operation when an address-only provider fails", async () => {
      const { signer: kms } = signer(
        { secretKey, identity: "address", throwError: new RangeError("throttled") },
        { expectedAddress: HARDHAT_ACCOUNT_0.address },
      );

      await rejectsWith(
        kms.confirmedAddress(),
        fakeKeyMessage("get address", ERRORS.signerCallFailed, { errorName: "RangeError" }),
      );
    });

    it("returns the pin, unconfirmed, when the provider can report neither key nor address", async () => {
      const { adapter, signer: kms } = signer(
        { secretKey, identity: "none" },
        { expectedAddress: HARDHAT_ACCOUNT_0.address.toLowerCase() },
      );

      assert.deepEqual(await kms.confirmedAddress(), {
        address: HARDHAT_ACCOUNT_0.address,
        confirmed: false,
      });
      assert.equal(adapter.calls.signDigest, 0);
    });
  });

  describe("the caller's signal", () => {
    const secretKey = hex(HARDHAT_ACCOUNT_0.secretKey);
    const digest = new Uint8Array(32).fill(7);

    /** An adapter whose signing calls never answer, and that records each call's signal. */
    function hangingSigner(timers = fakeTimers()) {
      const inner = fakeAdapter({ secretKey });
      const signals: AbortSignal[] = [];
      const adapter: KmsKeyAdapter = {
        describe: () => inner.describe(),
        getPublicKey: async (ctx) =>
          await (inner.getPublicKey?.(ctx) ?? Promise.reject(new Error("missing"))),
        signDigest: async (_request, ctx) => {
          signals.push(ctx.signal);
          return await new Promise<never>(() => {
            // Never answers.
          });
        },
      };
      return { kms: new KmsSigner(adapter, { ...baseOptions, timers }), signals, timers };
    }

    for (const [method, sign] of [
      [
        "signDigest",
        async (kms: KmsSigner, signal: AbortSignal) => await kms.signDigest(digest, { signal }),
      ],
      [
        "signPersonalMessage",
        async (kms: KmsSigner, signal: AbortSignal) =>
          await kms.signPersonalMessage(new Uint8Array([1, 2, 3]), { signal }),
      ],
      [
        "signTypedData",
        async (kms: KmsSigner, signal: AbortSignal) =>
          await kms.signTypedData(EIP712_MAIL, { signal }),
      ],
    ] as const) {
      it(`${method}: aborts the provider call and rejects with core.signer.cancelled`, async () => {
        const { kms, signals, timers } = hangingSigner();
        await kms.getAddress();
        const caller = new AbortController();

        const pending = sign(kms, caller.signal);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(signals.length, 1);
        assert.equal(signals[0]?.aborted, false);
        caller.abort();
        await rejectsWith(pending, cancelled("sign"));
        assert.equal(signals[0]?.aborted, true, "the provider call's signal aborted");
        assert.equal(signals.length, 1, "a cancelled call is not retried");
        assert.equal(timers.pending(), 0, "the deadline is cancelled");
      });
    }

    it("is told apart from a timeout", async () => {
      const { kms, timers } = hangingSigner();
      await kms.getAddress();
      const caller = new AbortController();
      const pending = kms.signDigest(digest, { signal: caller.signal });
      await new Promise((resolve) => setImmediate(resolve));
      timers.fire();
      caller.abort();
      await rejectsWith(
        pending,
        fakeKeyMessage("sign", ERRORS.signerNoAnswer, { timeout: 30_000 }),
      );
    });

    it("refuses before any provider call when the signal has already aborted", async () => {
      const { adapter, signer: kms } = signer({ secretKey });
      await kms.getAddress();

      await rejectsWith(kms.signDigest(digest, { signal: AbortSignal.abort() }), cancelled("sign"));
      assert.equal(adapter.calls.signDigest, 0);
    });

    it("does not retry an invalid signature once the signal has aborted", async () => {
      const caller = new AbortController();
      const { adapter, signer: kms } = signer({
        secretKey,
        wrongKeyForCalls: 1,
        beforeSign: async () => {
          caller.abort();
          await Promise.resolve();
        },
      });
      await kms.getAddress();

      await rejectsWith(kms.signDigest(digest, { signal: caller.signal }), cancelled("sign"));
      assert.equal(adapter.calls.signDigest, 1);
    });

    it("signs as before with a signal that does not abort", async () => {
      const { signer: kms } = signer({ secretKey });
      const caller = new AbortController();
      const withSignal = await kms.signDigest(digest, { signal: caller.signal });
      assert.deepEqual(withSignal, await kms.signDigest(digest));
      const message = new Uint8Array([1, 2, 3]);
      assert.equal(
        await kms.signPersonalMessage(message, { signal: caller.signal }),
        await kms.signPersonalMessage(message),
      );
      assert.equal(
        await kms.signTypedData(EIP712_MAIL, { signal: caller.signal }),
        await kms.signTypedData(EIP712_MAIL),
      );
      assert.deepEqual(await kms.getPublicKey({ signal: caller.signal }), await kms.getPublicKey());
    });

    describe("on the key lookup that callers share", () => {
      it("stops this caller's wait, and lets the lookup finish for the others", async () => {
        const { kms, answer, lookups } = heldLookup();
        const caller = new AbortController();
        const mine = kms.getPublicKey({ signal: caller.signal });
        const other = kms.getPublicKey();
        await new Promise((resolve) => setImmediate(resolve));

        caller.abort();
        await rejectsWith(mine, cancelled("get public key"));
        assert.equal(lookups[0]?.aborted, false, "the shared lookup goes on");
        answer();
        assert.deepEqual(await other, secp256k1.getPublicKey(secretKey, false));
        assert.equal(lookups.length, 1);
      });

      it("reports a sign whose lookup was cancelled as a cancelled sign", async () => {
        const { kms, answer } = heldLookup();
        const caller = new AbortController();
        const pending = kms.signDigest(digest, { signal: caller.signal });
        await new Promise((resolve) => setImmediate(resolve));

        caller.abort();
        await rejectsWith(pending, cancelled("sign"));
        answer();
      });

      it("passes the lookup's own error through", async () => {
        const inner = fakeAdapter({ secretKey });
        const failure = new HardhatPluginError("hardhat-kms", "adapter says no");
        const kms = new KmsSigner(
          {
            describe: () => inner.describe(),
            getPublicKey: async () => await Promise.reject(failure),
          },
          baseOptions,
        );

        await assert.rejects(
          kms.getPublicKey({ signal: new AbortController().signal }),
          (error: unknown) => error === failure,
        );
      });
    });
  });
});
