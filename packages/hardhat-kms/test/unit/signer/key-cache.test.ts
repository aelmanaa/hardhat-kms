import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HookContext } from "hardhat/types/hooks";

import hardhatKms from "../../../src/index.ts";
import { SignerCache } from "../../../src/internal/signer/key-cache.ts";
import type { KmsKeyConfig, KmsKeyUserConfig } from "../../../src/types.ts";
import { fakeAdapter } from "../../helpers/fake-adapter.ts";
import { fakeTimers } from "../../helpers/fake-timers.ts";
import { COW_ACCOUNT } from "../../helpers/vectors.ts";

const secretKey = new Uint8Array(Buffer.from(COW_ACCOUNT.secretKey, "hex"));

/** A runtime with one third-party key, whose adapters the test counts and can make fail. */
async function setUp(failFirst = false) {
  const keyConfig: unknown = { provider: "myvault" };
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKms],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a third-party provider's key
    kms: { keys: { vault: keyConfig as KmsKeyUserConfig } },
  });
  const state = { created: 0, closed: 0 };
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async () => {
      state.created++;
      if (failFirst && state.created === 1) {
        throw new TypeError("first attempt fails");
      }
      const adapter = fakeAdapter({ secretKey });
      return {
        ...adapter,
        close: async () => {
          state.closed++;
          await Promise.resolve();
        },
      };
    },
  });
  const key: KmsKeyConfig | undefined = hre.config.kms.keys.vault;
  assert.ok(key);
  const context: HookContext = hre;
  return { context, key, state };
}

describe("SignerCache", () => {
  it("creates one signer per key and reuses it", async () => {
    const { context, key, state } = await setUp();
    const cache = new SignerCache(fakeTimers());

    const [first, second] = await Promise.all([
      cache.signerFor(context, key),
      cache.signerFor(context, key),
    ]);
    assert.equal(first, second);
    assert.equal(await first.getAddress(), COW_ACCOUNT.address);
    assert.equal(state.created, 1);
  });

  it("does not keep a signer that failed to open", async () => {
    const { context, key, state } = await setUp(true);
    const cache = new SignerCache(fakeTimers());

    await assert.rejects(
      cache.signerFor(context, key),
      /creating the adapter failed \(TypeError\)/,
    );
    await cache.signerFor(context, key);
    assert.equal(state.created, 2);
  });

  it("closes the signers once idle after the last connection, and opens them again on use", async () => {
    const { context, key, state } = await setUp();
    const timers = fakeTimers();
    const cache = new SignerCache(timers);

    cache.connectionOpened();
    cache.connectionOpened();
    await cache.signerFor(context, key);
    cache.connectionClosed();
    assert.equal(timers.pending(), 0, "a connection is still open");

    cache.connectionClosed();
    assert.equal(timers.pending(), 1);
    timers.fire();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.closed, 1);

    await cache.signerFor(context, key);
    assert.equal(state.created, 2, "the next use opens a new signer");
  });

  it("keeps the signers when a connection opens before the idle timer fires", async () => {
    const { context, key, state } = await setUp();
    const timers = fakeTimers();
    const cache = new SignerCache(timers);

    cache.connectionOpened();
    await cache.signerFor(context, key);
    cache.connectionClosed();
    assert.equal(timers.pending(), 1);
    cache.connectionOpened();
    assert.equal(timers.pending(), 0);
    assert.equal(state.closed, 0);
  });

  it("does not let extra closes count against later connections", async () => {
    const { context, key, state } = await setUp();
    const timers = fakeTimers();
    const cache = new SignerCache(timers);

    cache.connectionOpened();
    cache.connectionClosed();
    cache.connectionClosed();
    cache.connectionOpened();
    cache.connectionOpened();
    await cache.signerFor(context, key);
    cache.connectionClosed();
    assert.equal(timers.pending(), 0, "one connection is still open");
    assert.equal(state.closed, 0);
  });

  it("starts no idle timer when nothing is open", () => {
    const timers = fakeTimers();
    const cache = new SignerCache(timers);

    cache.connectionOpened();
    cache.connectionClosed();
    cache.connectionClosed();
    assert.equal(timers.pending(), 0);
  });
});

describe("SignerCache adapters", () => {
  it("passes an adapter's status messages to Hardhat, and survives a failing close", async () => {
    const keyConfig: unknown = { provider: "myvault" };
    const hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKms],
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a third-party provider's key
      kms: { keys: { vault: keyConfig as KmsKeyUserConfig } },
    });
    const shown: string[] = [];
    hre.hooks.registerHandlers("userInterruptions", {
      displayMessage: async (_context, interruptor, message) => {
        shown.push(`${interruptor}: ${message}`);
        await Promise.resolve();
      },
    });
    hre.hooks.registerHandlers("kms", {
      createKeyAdapter: async () => {
        const adapter = fakeAdapter({ secretKey });
        return {
          ...adapter,
          getPublicKey: async (ctx) => {
            await ctx.displayMessage("approve the request on your device");
            return await (adapter.getPublicKey?.(ctx) ?? Promise.reject(new Error("no key")));
          },
          close: async () => await Promise.reject(new Error("close failed")),
        };
      },
    });
    const key = hre.config.kms.keys.vault;
    assert.ok(key);
    const cache = new SignerCache(fakeTimers());
    const signer = await cache.signerFor(hre, key);

    assert.equal(await signer.getAddress(), COW_ACCOUNT.address);
    assert.deepEqual(shown, ["hardhat-kms: approve the request on your device"]);
    await cache.closeAll();
  });
});

describe("SignerCache idle close", () => {
  it("waits for a request that is still signing", async () => {
    const { context, key, state } = await setUp();
    const timers = fakeTimers();
    const cache = new SignerCache(timers);
    let finish: (() => void) | undefined;
    const signing = new Promise<void>((resolve) => {
      finish = resolve;
    });

    cache.connectionOpened();
    const inFlight = cache.withSigner(context, key, async () => {
      await signing;
    });
    await new Promise((resolve) => setImmediate(resolve));
    cache.connectionClosed();
    timers.fire();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.closed, 0, "the signer is still in use");
    assert.equal(timers.pending(), 1, "the idle close tries again later");

    finish?.();
    await inFlight;
    timers.fire();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.closed, 1);
  });
});
