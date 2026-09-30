import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsPlugin from "../../src/index.ts";

describe("Hardhat runtime environment", () => {
  it("loads the plugin", async () => {
    const hre = await createHardhatRuntimeEnvironment({ plugins: [hardhatKmsPlugin] });

    assert.ok(hre.config.plugins.some((plugin) => plugin.id === "hardhat-kms"));
  });
});
