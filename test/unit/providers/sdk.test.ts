import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { HardhatPluginError } from "hardhat/plugins";

import { loadSdk } from "../../../src/internal/providers/sdk.ts";

/** A throwaway project with fake SDK packages in its node_modules. */
let project: string;

function fakePackage(name: string, version: string): void {
  const directory = path.join(project, "node_modules", ...name.split("/"));
  mkdirSync(path.join(directory, "lib"), { recursive: true });
  writeFileSync(
    path.join(directory, "package.json"),
    // An empty version writes a package.json without one.
    JSON.stringify(
      version === "" ? { name, main: "lib/index.js" } : { name, version, main: "lib/index.js" },
    ),
  );
  writeFileSync(
    path.join(directory, "lib", "index.js"),
    `exports.marker = ${JSON.stringify(`${name}@${version}`)};`,
  );
}

async function assertPluginError(promise: Promise<unknown>, includes: string[]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HardhatPluginError);
    for (const part of includes) {
      assert.ok(error.message.includes(part), `"${error.message}" should include "${part}"`);
    }
    return true;
  });
}

describe("loadSdk", () => {
  before(() => {
    project = mkdtempSync(path.join(tmpdir(), "hardhat-kms-sdk-"));
    writeFileSync(
      path.join(project, "package.json"),
      JSON.stringify({ name: "project", private: true }),
    );
    fakePackage("@fake/kms", "3.4.5");
    fakePackage("@fake/old", "2.9.9");
    fakePackage("@fake/unversioned", "");
  });

  after(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("loads a package from the project, not from the plugin's own dependencies", async () => {
    const sdk = await loadSdk({ packageName: "@fake/kms", range: "^3.0.0" }, project, "fake");

    assert.ok(typeof sdk === "object" && sdk !== null && "marker" in sdk);
    assert.equal(sdk.marker, "@fake/kms@3.4.5");
  });

  it("names the package and the install command when the package is missing", async () => {
    await assertPluginError(
      loadSdk({ packageName: "@fake/missing", range: "^1.0.0" }, project, "fake"),
      ["fake", "@fake/missing is not installed", 'npm install @fake/missing@"^1.0.0"'],
    );
  });

  it("rejects a version outside the supported range", async () => {
    await assertPluginError(
      loadSdk({ packageName: "@fake/old", range: "^3.0.0" }, project, "fake"),
      ["found @fake/old 2.9.9", "supports ^3.0.0", 'npm install @fake/old@"^3.0.0"'],
    );
  });

  it("rejects a package whose version cannot be read", async () => {
    await assertPluginError(
      loadSdk({ packageName: "@fake/unversioned", range: "^1.0.0" }, project, "fake"),
      ["found @fake/unversioned with an unknown version"],
    );
  });

  it("does not find packages that only this plugin depends on", async () => {
    // zod is a dependency of the plugin, but not of the throwaway project.
    await assertPluginError(loadSdk({ packageName: "zod", range: "^3.0.0" }, project, "fake"), [
      "zod is not installed",
    ]);
  });
});
