import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import hardhatKmsGcp from "../../src/index.ts";

const manifest: unknown = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);
const name: unknown =
  typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "name") : undefined;

describe("the @hardhat-kms/gcp package name", () => {
  it("is scoped under @hardhat-kms", () => {
    assert.equal(name, "@hardhat-kms/gcp");
  });

  // Hardhat looks up npmPackage (or the id) to find the plugin's package.json, and prints the id
  // in its install errors, so both must be the name users install.
  it("is the plugin's id and npmPackage", () => {
    assert.equal(hardhatKmsGcp.id, name);
    assert.equal(hardhatKmsGcp.npmPackage, name);
  });
});
