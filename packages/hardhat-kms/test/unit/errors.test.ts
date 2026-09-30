import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardhatPluginError } from "hardhat/plugins";

import { PLUGIN_ID } from "../../src/internal/constants.ts";
import { kmsError } from "../../src/internal/errors.ts";

describe("kmsError", () => {
  it("prefixes the message with the provider, operation and key", () => {
    const error = kmsError("boom", { provider: "aws", operation: "sign", key: "alias/deployer" });

    assert.ok(error instanceof HardhatPluginError);
    assert.equal(error.pluginId, PLUGIN_ID);
    assert.equal(error.message, "aws, sign, key alias/deployer: boom");
  });

  it("omits missing context", () => {
    assert.equal(kmsError("boom").message, "boom");
    assert.equal(kmsError("boom", { operation: "sign" }).message, "sign: boom");
  });
});
