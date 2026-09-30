import assert from "node:assert/strict";
import { describe, it } from "node:test";

import hardhatKmsPlugin from "../../src/index.ts";

describe("plugin definition", () => {
  it("has the expected id and npm package", () => {
    assert.equal(hardhatKmsPlugin.id, "hardhat-kms");
    assert.equal(hardhatKmsPlugin.npmPackage, "hardhat-kms");
  });
});
