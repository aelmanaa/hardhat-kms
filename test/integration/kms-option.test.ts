import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { HardhatPluginError } from "hardhat/plugins";

import hardhatKms from "../../src/index.ts";
import { commandLineKeys } from "../../src/internal/hook-handlers/hre.ts";
import { createKeyAdapter } from "../../src/internal/providers/create-adapter.ts";

const VARIABLES = [
  "AWS_KMS_KEY_ID",
  "AWS_KMS_KEY_IDS",
  "GCP_PROJECT_ID",
  "GCP_LOCATION",
  "GCP_KEY_RING",
  "GCP_KEY_NAME",
  "GCP_KEY_VERSION",
  "AZURE_KEY_VAULT_KEY_ID",
] as const;
const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of VARIABLES) {
    const value = saved[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe("--kms", () => {
  it("loads keys from Foundry's variables when the runtime is created", async () => {
    process.env.AWS_KMS_KEY_IDS = "alias/a,alias/b";
    const hre = await createHardhatRuntimeEnvironment(
      { plugins: [hardhatKms], kms: { defaults: { timeoutMs: 999 } } },
      { kms: "aws" },
    );

    assert.equal(hre.globalOptions.kms, "aws");
    assert.deepEqual(
      commandLineKeys(hre).map((key) => [key.displayId, key.timeoutMs]),
      [
        ["aws:<AWS_KMS_KEY_IDS[0]>", 999],
        ["aws:<AWS_KMS_KEY_IDS[1]>", 999],
      ],
    );
    assert.ok(Object.isFrozen(commandLineKeys(hre)));
  });

  it("loads nothing without the option, even when Foundry's variables are set", async () => {
    process.env.AWS_KMS_KEY_ID = "alias/a";
    const hre = await createHardhatRuntimeEnvironment({ plugins: [hardhatKms] });

    assert.equal(hre.globalOptions.kms, undefined);
    assert.deepEqual(commandLineKeys(hre), []);
  });

  it("fails when the runtime is created, before any task runs", async () => {
    delete process.env.AWS_KMS_KEY_ID;
    delete process.env.AWS_KMS_KEY_IDS;

    await assert.rejects(
      createHardhatRuntimeEnvironment({ plugins: [hardhatKms] }, { kms: "aws" }),
      (error: unknown) => {
        assert.ok(error instanceof HardhatPluginError);
        assert.match(
          error.message,
          /--kms aws: set AWS_KMS_KEY_ID, or AWS_KMS_KEY_IDS for several keys/,
        );
        return true;
      },
    );
  });

  it("loads a single key, and keys of several providers", async () => {
    process.env.AWS_KMS_KEY_ID = "alias/a";
    const one = await createHardhatRuntimeEnvironment({ plugins: [hardhatKms] }, { kms: "aws" });
    assert.deepEqual(
      commandLineKeys(one).map((key) => key.displayId),
      ["aws:<AWS_KMS_KEY_ID>"],
    );

    Object.assign(process.env, {
      GCP_PROJECT_ID: "p",
      GCP_LOCATION: "l",
      GCP_KEY_RING: "r",
      GCP_KEY_NAME: "k",
      GCP_KEY_VERSION: "1",
      AZURE_KEY_VAULT_KEY_ID: "https://ops.vault.azure.net/keys/k",
    });
    const several = await createHardhatRuntimeEnvironment(
      { plugins: [hardhatKms] },
      { kms: "gcp,azure" },
    );
    assert.deepEqual(
      commandLineKeys(several).map((key) => key.name),
      ["GCP_KEY_*", "AZURE_KEY_VAULT_KEY_ID"],
    );
  });

  it("finds the keys from a hook context, as the network hook will", async () => {
    process.env.AWS_KMS_KEY_ID = "alias/a";
    const hre = await createHardhatRuntimeEnvironment(
      { plugins: [hardhatKms], kms: { keys: { k: { provider: "aws", keyId: "alias/k" } } } },
      { kms: "aws" },
    );
    let fromContext: readonly unknown[] = [];
    hre.hooks.registerHandlers("kms", {
      createKeyAdapter: async (context) => {
        fromContext = commandLineKeys(context);
        throw new Error("stop");
      },
    });
    const key = hre.config.kms.keys.k;
    assert.ok(key);
    await assert.rejects(createKeyAdapter(hre, key), /stop/);

    assert.equal(fromContext.length, 1);
    assert.equal(fromContext, commandLineKeys(hre));
  });

  it("treats an empty value as off, and does not block help", async () => {
    delete process.env.AWS_KMS_KEY_ID;
    for (const kms of ["", "  "]) {
      const hre = await createHardhatRuntimeEnvironment({ plugins: [hardhatKms] }, { kms });
      assert.deepEqual(commandLineKeys(hre), []);
    }
    const help = await createHardhatRuntimeEnvironment(
      { plugins: [hardhatKms] },
      { kms: "aws", help: true },
    );
    assert.deepEqual(commandLineKeys(help), []);
  });
});
