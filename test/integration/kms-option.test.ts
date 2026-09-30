import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { HardhatPluginError } from "hardhat/plugins";

import hardhatKms from "../../src/index.ts";
import { commandLineKeys } from "../../src/internal/hook-handlers/hre.ts";

const VARIABLES = ["AWS_KMS_KEY_ID", "AWS_KMS_KEY_IDS"] as const;
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
});
