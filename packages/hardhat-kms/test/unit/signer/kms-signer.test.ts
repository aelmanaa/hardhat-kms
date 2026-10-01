import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HardhatPluginError } from "hardhat/plugins";

import { KmsSigner, type KmsSignerOptions } from "../../../src/internal/signer/kms-signer.ts";
import type { KmsKeyAdapter } from "../../../src/internal/signer/types.ts";
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

      await assertPluginError(kms.signDigest(new Uint8Array(32)), [
        HARDHAT_ACCOUNT_0.address,
        other,
        "rotated",
      ]);
      assert.equal(adapter.calls.signDigest, 0);
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
        assert.throws(
          () => new KmsSigner(fakeAdapter({ secretKey }), { ...baseOptions, expectedAddress }),
          (error: unknown) =>
            error instanceof HardhatPluginError &&
            error.message.includes("configured address is invalid"),
        );
      }
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
        assert.throws(
          () => new KmsSigner(fakeAdapter({ secretKey }), { ...baseOptions, timeoutMs }),
          (error: unknown) =>
            error instanceof HardhatPluginError && error.message.includes("timeout"),
        );
      }
    });

    it("requires a way to identify the key", () => {
      assert.throws(
        () =>
          new KmsSigner(
            fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey), identity: "none" }),
            baseOptions,
          ),
        HardhatPluginError,
      );
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

      await assertPluginError(kms.signDigest(new Uint8Array(32).fill(6)), [
        "invalid signature",
        "fake-key-1",
      ]);
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

      await assertPluginError(
        new KmsSigner(adapter, baseOptions).signDigest(new Uint8Array(32).fill(8)),
        ["invalid signature", "does not recover to the configured address"],
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

      await assertPluginError(new KmsSigner(adapter, baseOptions).signDigest(new Uint8Array(32)), [
        "cannot sign",
      ]);
    });
  });

  describe("caller errors", () => {
    it("rejects a digest that is not 32 bytes before calling the provider", async () => {
      const { adapter, signer: kms } = signer({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) });

      await assertPluginError(kms.signDigest(new Uint8Array(31)), ["32-byte digest", "31 bytes"]);
      assert.equal(adapter.calls.signDigest, 0);
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

      await assertPluginError(
        new KmsSigner(adapter, baseOptions).signDigest(new Uint8Array(32).fill(7)),
        ["RangeError"],
        ["throttled"],
      );
      assert.equal(calls, 2);
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
});
