import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsPlugin from "../../src/index.ts";

describe("Hardhat runtime environment", () => {
  it("registers the plugin object", async () => {
    const hre = await createHardhatRuntimeEnvironment({ plugins: [hardhatKmsPlugin] });

    assert.ok(hre.config.plugins.includes(hardhatKmsPlugin));
  });

  it("connects to a simulated network with the plugin loaded", async () => {
    const hre = await createHardhatRuntimeEnvironment({ plugins: [hardhatKmsPlugin] });
    const connection = await hre.network.create();

    try {
      assert.equal(await connection.provider.request({ method: "eth_chainId" }), "0x7a69");
    } finally {
      await connection.close();
    }
  });
});
