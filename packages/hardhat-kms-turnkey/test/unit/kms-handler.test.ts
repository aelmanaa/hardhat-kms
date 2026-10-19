import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

import type { KmsKeyAdapter, KmsKeyConfig } from "hardhat-kms/types";
import type { HookContext } from "hardhat/types/hooks";

import { kmsHandlers, PACKAGE_NAME } from "../../src/internal/hook-handlers/kms.ts";
import { turnkeyKey } from "../helpers/keys.ts";

/** The installed hardhat-kms version, which the handler compares its own version with. */
const coreVersion = String(
  Reflect.get(Object(createRequire(import.meta.url)("hardhat-kms/package.json")), "version"),
);
/** A version that differs from the installed hardhat-kms, whatever that version is. */
const otherVersion = `${coreVersion}-other`;

// The handler never reads the context; it only passes it on.
const context: HookContext = Object.create(null);
const adapter: KmsKeyAdapter = {
  describe: () => ({ provider: "turnkey", pinnedId: "p", displayId: "d" }),
};
const otherKey: KmsKeyConfig = {
  provider: "aws",
  name: "aws",
  displayId: "aws:alias/x",
  timeoutMs: 1,
  keyId: { get: async () => await Promise.resolve("alias/x"), display: "alias/x" },
};

/** A `next` that a Turnkey key must never reach. */
async function next(): Promise<KmsKeyAdapter> {
  return await Promise.reject(new Error("not next"));
}

describe("the kms hook handler", () => {
  it("passes keys of other providers on, without loading the adapter", async () => {
    let loads = 0;
    const handlers = kmsHandlers(coreVersion, async () => {
      loads++;
      return await Promise.resolve(async () => await Promise.resolve(adapter));
    });
    assert.ok(handlers.createKeyAdapter);
    const passed = await handlers.createKeyAdapter(context, otherKey, async (_context, key) => {
      assert.equal(key, otherKey);
      return await Promise.resolve(adapter);
    });
    assert.equal(passed, adapter);
    assert.equal(loads, 0);
  });

  it("loads the adapter once for every Turnkey key, and again after a failed load", async () => {
    let loads = 0;
    const keys: KmsKeyConfig[] = [];
    const handlers = kmsHandlers(coreVersion, async () => {
      loads++;
      if (loads === 1) {
        throw new TypeError("load failed");
      }
      return await Promise.resolve(async (key: KmsKeyConfig) => {
        keys.push(key);
        return await Promise.resolve(adapter);
      });
    });
    const create = handlers.createKeyAdapter;
    assert.ok(create);
    const key = turnkeyKey();

    await assert.rejects(create(context, key, next), /load failed/);
    assert.equal(await create(context, key, next), adapter);
    assert.equal(await create(context, turnkeyKey(), next), adapter);
    assert.equal(loads, 2);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], key);
  });

  it("refuses to build an adapter when hardhat-kms is another version", async () => {
    let loads = 0;
    const handlers = kmsHandlers(otherVersion, async () => {
      loads++;
      return await Promise.resolve(async () => await Promise.resolve(adapter));
    });
    assert.ok(handlers.createKeyAdapter);
    await assert.rejects(
      handlers.createKeyAdapter(context, turnkeyKey(), async () => await Promise.resolve(adapter)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(PACKAGE_NAME), error.message);
        assert.ok(error.message.includes(otherVersion), error.message);
        return true;
      },
    );
    assert.equal(loads, 0);
  });

  it("loads the real adapter module by default", async () => {
    const { default: load } = await import("../../src/internal/hook-handlers/kms.ts");
    const handlers = await load();
    assert.ok(handlers.createKeyAdapter);
    const built = await handlers.createKeyAdapter(
      context,
      turnkeyKey(),
      async () => await Promise.resolve(adapter),
    );
    assert.notEqual(built, adapter);
    assert.equal(built.describe().provider, "turnkey");
  });
});
