import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import hardhatKmsPlugin from "../../src/index.ts";
import * as providerUtils from "../../src/provider-utils.ts";

describe("plugin definition", () => {
  it("has the expected id and npm package", () => {
    assert.equal(hardhatKmsPlugin.id, "hardhat-kms");
    assert.equal(hardhatKmsPlugin.npmPackage, "hardhat-kms");
  });

  it("depends on no cloud SDK: each provider package brings its own", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    assert.ok(typeof manifest === "object" && manifest !== null);
    const dependencies = Object.keys(Reflect.get(manifest, "dependencies") ?? {});
    const cloud = dependencies.filter((name) => /^@(aws-sdk|google-cloud|azure)\//.test(name));
    assert.deepEqual(cloud, []);
  });

  it("exports the helpers provider plugins build on", () => {
    assert.deepEqual(Object.keys(providerUtils).toSorted(), [
      "InvalidPublicKeyError",
      "kmsError",
      "parseAwsKeyId",
      "publicKeyFromSpkiDer",
    ]);
  });
});
