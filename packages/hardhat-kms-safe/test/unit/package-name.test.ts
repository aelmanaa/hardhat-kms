import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import hardhatKmsSafe from "../../src/index.ts";
import { PACKAGE_NAME } from "../../src/internal/tasks/propose.ts";

const manifest: unknown = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);
const field = (name: string): unknown =>
  typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, name) : undefined;

describe("the @hardhat-kms/safe package", () => {
  it("is scoped under @hardhat-kms, and is the plugin's id and npmPackage", () => {
    assert.equal(field("name"), "@hardhat-kms/safe");
    assert.equal(hardhatKmsSafe.id, field("name"));
    assert.equal(hardhatKmsSafe.npmPackage, field("name"));
    assert.equal(PACKAGE_NAME, field("name"));
  });

  it("has no runtime dependency, and takes viem, Hardhat and the same hardhat-kms as peers", () => {
    assert.equal(field("dependencies"), undefined);
    const peers = field("peerDependencies");
    assert.ok(typeof peers === "object" && peers !== null);
    assert.deepEqual(Object.keys(peers).toSorted(), ["hardhat", "hardhat-kms", "viem"]);
    assert.equal(Reflect.get(peers, "hardhat-kms"), "workspace:*");
  });

  it("adds kms safe propose under the core's kms task", () => {
    const ids = (hardhatKmsSafe.tasks ?? []).map((task) => task.id.join(" "));
    assert.deepEqual(ids, ["kms safe", "kms safe propose"]);
  });
});
