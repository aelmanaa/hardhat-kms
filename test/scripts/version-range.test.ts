// The floor that scripts/test-sdk-floors.ts reads from a dependency range
// (`scripts/version-range.ts`): a caret range, or caret alternatives in one major that skip some
// releases, and nothing that allows another major.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { floorOf } from "../../scripts/version-range.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("floorOf", () => {
  it("reads the floor of a caret range", () => {
    assert.equal(floorOf("^3.1143.0"), "3.1143.0");
    assert.equal(floorOf("^11.0.0"), "11.0.0");
  });

  it("reads the floor of a range that skips releases of the same major", () => {
    assert.equal(floorOf("^6.5.0 <6.11.0 || ^6.11.1"), "6.5.0");
    assert.equal(floorOf("^6.5.0 <6.11.0||^6.11.1"), "6.5.0");
    assert.equal(floorOf("^1.2.3 <1.4.0 || ^1.4.1 <1.5.0 || ^1.5.2"), "1.2.3");
    // The last alternative may end before the next major too.
    assert.equal(floorOf("^6.5.0 <6.11.0"), "6.5.0");
  });

  it("tests @hardhat-kms/gcp's google-gax at 6.5.0", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(root, "packages", "hardhat-kms-gcp", "package.json"), "utf8"),
    );
    const dependencies: unknown =
      typeof manifest === "object" && manifest !== null
        ? Reflect.get(manifest, "dependencies")
        : undefined;
    const range: unknown =
      typeof dependencies === "object" && dependencies !== null
        ? Reflect.get(dependencies, "google-gax")
        : undefined;
    assert.equal(typeof range, "string");
    assert.equal(floorOf(String(range)), "6.5.0");
  });

  it("rejects a range that allows another major", () => {
    for (const range of [
      ">=6.5.0 <6.11.0 || >=6.11.1",
      ">=6.5.0",
      "^6.5.0 || ^7.0.0",
      "^6.5.0 <7.1.0",
      "^6.5.0 <6.11.0 || ^7.0.1",
      "*",
      "6.x",
    ]) {
      assert.throws(() => floorOf(range), Error, range);
    }
  });

  it("rejects other forms and alternatives out of order", () => {
    for (const range of [
      "6.5.0",
      "~6.5.0",
      "^6.5",
      "^6.5.0-beta.1",
      "^6.5.0 <6.5.0",
      "^6.5.0 <6.4.0",
      "^6.11.1 || ^6.5.0 <6.11.0",
      "^6.5.0 || ^6.11.1",
      "^6.5.0 <6.11.0 || ^6.10.0",
      // Adjacent: skips nothing, and allows 6.11.0 again.
      "^6.5.0 <6.11.0 || ^6.11.0",
      "^6.5.0 <6.11.0 ||",
      "",
      "workspace:*",
      "catalog:",
    ]) {
      assert.throws(() => floorOf(range), Error, range);
    }
  });

  it("rejects a 0.x floor, where a caret allows one minor only", () => {
    assert.throws(() => floorOf("^0.19.0"), /0\.x/);
  });

  it("names the forms it accepts", () => {
    assert.throws(() => floorOf("~6.5.0"), /\^1\.2\.3 <1\.4\.0 \|\| \^1\.4\.1 \(got ~6\.5\.0\)/);
  });
});
