// The adapter contract check and chain edge cases.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { HardhatPluginError } from "hardhat/plugins";

import hardhatKms from "../../src/index.ts";
import { createKeyAdapter } from "../../src/internal/providers/create-adapter.ts";
import type { KmsKeyAdapter, KmsKeyConfig, KmsKeyUserConfig } from "../../src/types.ts";

const describeKey = () => ({ provider: "myvault", pinnedId: "v1", displayId: "myvault:vault" });
const sign = async () => await Promise.resolve({ r: 1n, s: 1n });
const publicKey = async () => await Promise.resolve(new Uint8Array(65));

async function runtimeReturning(returned: unknown) {
  const keysValue: unknown = {
    vault: { provider: "myvault" },
    aws: { provider: "aws", keyId: "alias/a" },
  };
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKms],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a provider this package does not know
    kms: { keys: keysValue as Record<string, KmsKeyUserConfig> },
  });
  hre.hooks.registerHandlers("kms", {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately arbitrary adapters
    createKeyAdapter: async () => returned as KmsKeyAdapter,
  });
  return hre;
}

function keyOf(
  hre: { config: { kms: { keys: Record<string, KmsKeyConfig> } } },
  name: string,
): KmsKeyConfig {
  const found = hre.config.kms.keys[name];
  assert.ok(found);
  return found;
}

async function assertRejects(
  returned: unknown,
  includes: string[],
  excludes: string[] = [],
): Promise<void> {
  const hre = await runtimeReturning(returned);
  await assert.rejects(createKeyAdapter(hre, keyOf(hre, "vault")), (error: unknown) => {
    assert.ok(error instanceof HardhatPluginError, String(error));
    for (const part of includes) {
      assert.ok(error.message.includes(part), `"${error.message}" should include "${part}"`);
    }
    for (const part of excludes) {
      assert.ok(!error.message.includes(part), `"${error.message}" must not include "${part}"`);
    }
    return true;
  });
}

describe("kms hook adapter contract", () => {
  it("names the handler when one returns nothing instead of calling next", async () => {
    await assertRejects(undefined, [
      "myvault, create adapter, key myvault:vault: a kms.createKeyAdapter handler returned nothing",
      "next(context, key)",
    ]);
    await assertRejects(null, ["returned nothing"]);
  });

  it("rejects a describe that is not a function, throws, or returns incomplete data", async () => {
    await assertRejects({ describe: "x", signDigest: sign, getPublicKey: publicKey }, [
      "has no describe() method",
    ]);
    await assertRejects(
      {
        describe: () => {
          throw new TypeError("boom secret=abc");
        },
        signDigest: sign,
        getPublicKey: publicKey,
      },
      ["describe() failed (TypeError)"],
      ["secret=abc"],
    );
    await assertRejects(
      { describe: () => ({ provider: "myvault" }), signDigest: sign, getPublicKey: publicKey },
      ["non-empty strings for pinnedId, displayId"],
    );
    await assertRejects({ describe: () => undefined, signDigest: sign, getPublicKey: publicKey }, [
      "non-empty strings for provider, pinnedId, displayId",
    ]);
  });

  it("rejects known methods that are set but are not functions", async () => {
    for (const name of ["signMessage", "signTypedData", "signTransaction", "getAddress", "close"]) {
      await assertRejects(
        { describe: describeKey, signDigest: sign, getPublicKey: publicKey, [name]: 42 },
        [`the adapter's ${name} is not a function`],
      );
    }
    await assertRejects(
      { describe: describeKey, signDigest: null, signMessage: sign, getPublicKey: publicKey },
      ["signDigest is not a function"],
    );
  });

  it("rejects a signTransactionOutlivesAbort that is set but is not a boolean (#537)", async () => {
    for (const value of [1, "true", null, {}, () => true]) {
      await assertRejects(
        {
          describe: describeKey,
          signDigest: sign,
          getPublicKey: publicKey,
          signTransactionOutlivesAbort: value,
        },
        [
          "myvault, create adapter, key myvault:vault: the adapter's signTransactionOutlivesAbort is not a boolean",
        ],
      );
    }
    for (const value of [true, false, undefined]) {
      const adapter = {
        describe: describeKey,
        signDigest: sign,
        getPublicKey: publicKey,
        signTransactionOutlivesAbort: value,
      };
      const hre = await runtimeReturning(adapter);
      assert.equal(await createKeyAdapter(hre, keyOf(hre, "vault")), adapter);
    }
  });

  it("closes an adapter it refuses, so its clients cannot keep the process running", async () => {
    let closed = 0;
    const close = async () => {
      closed++;
      await Promise.resolve();
    };
    await assertRejects({ describe: describeKey, getPublicKey: publicKey, close }, [
      "has no signing method",
    ]);
    assert.equal(closed, 1);

    // A close that fails does not hide the reason the adapter was refused.
    await assertRejects(
      {
        describe: describeKey,
        getPublicKey: publicKey,
        close: () => {
          throw new Error("close failed");
        },
      },
      ["has no signing method"],
    );
  });

  it("refuses an adapter whose only signing method is signTransaction", async () => {
    // Messages and typed data need signDigest, signMessage or signTypedData.
    await assertRejects({ describe: describeKey, signTransaction: sign, getPublicKey: publicKey }, [
      "has no signing method (signDigest, signMessage, signTypedData)",
    ]);
  });

  it("accepts every shape the contract allows", async () => {
    for (const returned of [
      {
        describe: describeKey,
        signDigest: sign,
        getAddress: async () => await Promise.resolve("0x"),
      },
      { describe: describeKey, signMessage: sign, getPublicKey: publicKey },
      { describe: describeKey, signTypedData: sign, getPublicKey: publicKey },
      { describe: describeKey, signDigest: sign, signTransaction: sign, getPublicKey: publicKey },
      { describe: describeKey, signMessage: sign, signTransaction: sign, getPublicKey: publicKey },
    ]) {
      const hre = await runtimeReturning(returned);
      assert.equal(await createKeyAdapter(hre, keyOf(hre, "vault")), returned);
    }
  });
});

describe("kms hook chain", () => {
  it("hands the key a handler passed to next on to the end of the chain", async () => {
    const hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKms],
      kms: { keys: { aws: { provider: "aws", keyId: "alias/a" } } },
    });
    hre.hooks.registerHandlers("kms", {
      createKeyAdapter: async (context, key, next) => {
        const renamed: unknown = { ...key, provider: "renamed" };
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a key no provider claims
        return await next(context, renamed as KmsKeyConfig);
      },
    });

    await assert.rejects(
      createKeyAdapter(hre, keyOf(hre, "aws")),
      /renamed, create adapter, key aws:alias\/a: no plugin provides "renamed" keys/,
    );
  });
});
