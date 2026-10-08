// The Node.js floor check of scripts/test-hardhat-versions.ts (`scripts/node-floor.ts`): Hardhat's
// MIN_SUPPORTED_NODE_VERSION against the floor of engines.node of hardhat-kms.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  nodeFloorMismatch,
  nodeFloorOf,
  readHardhatNodeMinimum,
} from "../../scripts/node-floor.ts";
import {
  installedDirectory,
  readJson,
  root,
  stringRecord,
} from "../../scripts/temporary-install.ts";

describe("nodeFloorOf", () => {
  it("reads a single lower bound", () => {
    assert.deepEqual(nodeFloorOf(">=22.13.0"), [22, 13, 0]);
    assert.deepEqual(nodeFloorOf("^22.13.0"), [22, 13, 0]);
    assert.deepEqual(nodeFloorOf("22.13.0"), [22, 13, 0]);
  });

  it("takes the lowest bound of alternatives joined by ||", () => {
    assert.deepEqual(nodeFloorOf("^22.13.0 || >=24.0.0"), [22, 13, 0]);
    assert.deepEqual(nodeFloorOf(">=24.0.0 || ^22.13.0"), [22, 13, 0]);
    assert.deepEqual(nodeFloorOf("^22.13.0||^24.0.0||>=26.0.0"), [22, 13, 0]);
  });

  it("rejects a range it cannot read a floor from", () => {
    for (const range of ["", "22.x", ">22.13.0", ">=22.13.0 <25.0.0", ">=22", "*"]) {
      assert.throws(() => nodeFloorOf(range), /engines\.node must list lower bounds/, range);
    }
  });
});

describe("nodeFloorMismatch", () => {
  it("passes when Hardhat's minimum equals our floor", () => {
    assert.equal(nodeFloorMismatch("3.18.0", [22, 13, 0], ">=22.13.0"), undefined);
    assert.equal(nodeFloorMismatch("3.18.0", [22, 13, 0], "^22.13.0 || >=24.0.0"), undefined);
  });

  it("fails, naming both values, when Hardhat's minimum is higher", () => {
    const message = nodeFloorMismatch("3.19.0", [22, 18, 0], ">=22.13.0");
    assert.ok(message !== undefined);
    assert.match(message, /hardhat 3\.19\.0 requires Node\.js 22\.18\.0/);
    assert.match(message, /engines\.node of hardhat-kms is >=22\.13\.0 \(floor 22\.13\.0\)/);
    assert.match(message, /Raise engines\.node of every package to >=22\.18\.0/);
  });

  it("fails when Hardhat's minimum is higher than the lowest || alternative", () => {
    const message = nodeFloorMismatch("3.19.0", [24, 0, 0], "^22.13.0 || >=24.0.0");
    assert.ok(message !== undefined);
    assert.match(message, /requires Node\.js 24\.0\.0/);
    assert.match(message, /\(floor 22\.13\.0\)/);
  });

  it("fails, naming both values, when Hardhat's minimum is lower", () => {
    const message = nodeFloorMismatch("3.4.2", [22, 10, 0], ">=22.13.0");
    assert.ok(message !== undefined);
    assert.match(message, /hardhat 3\.4\.2 requires Node\.js 22\.10\.0/);
    assert.match(message, /\(floor 22\.13\.0\)/);
    assert.match(message, /raise the hardhat peer floor/);
  });
});

describe("readHardhatNodeMinimum", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "node-floor-test-"));
  after(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /** A fake hardhat package whose node-version.js has `body`. */
  function fakeHardhat(name: string, body: string): string {
    const directory = path.join(scratch, name);
    const cli = path.join(directory, "dist", "src", "internal", "cli");
    mkdirSync(cli, { recursive: true });
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(path.join(cli, "node-version.js"), body);
    return directory;
  }

  it("reads the constant from the installed file", async () => {
    const directory = fakeHardhat(
      "above",
      "export const MIN_SUPPORTED_NODE_VERSION = [22, 18, 0];\n",
    );
    assert.deepEqual(await readHardhatNodeMinimum(directory), [22, 18, 0]);
  });

  it("fails when the constant is missing or malformed", async () => {
    for (const [name, body] of [
      ["missing", "export const OTHER = [22, 13, 0];\n"],
      ["short", "export const MIN_SUPPORTED_NODE_VERSION = [22, 13];\n"],
      ["strings", 'export const MIN_SUPPORTED_NODE_VERSION = ["22", "13", "0"];\n'],
    ] as const) {
      await assert.rejects(
        readHardhatNodeMinimum(fakeHardhat(name, body)),
        /does not export MIN_SUPPORTED_NODE_VERSION as three integers/,
        name,
      );
    }
  });

  it("reads the lockfile's hardhat, which matches engines.node of hardhat-kms", async () => {
    const plugin = path.join(root, "packages", "hardhat-kms");
    const enginesNode = stringRecord(readJson(path.join(plugin, "package.json")).engines).node;
    assert.ok(enginesNode !== undefined);
    const minimum = await readHardhatNodeMinimum(installedDirectory(plugin, "hardhat"));
    assert.equal(nodeFloorMismatch("lockfile", minimum, enginesNode), undefined);
  });
});
