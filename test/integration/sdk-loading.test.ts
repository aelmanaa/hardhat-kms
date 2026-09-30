import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLOUD_SDK = /^(@aws-sdk\/|@smithy\/|@google-cloud\/|google-gax|@azure\/)/;

describe("SDK loading", () => {
  it("loads the plugin and resolves every provider's config without importing a cloud SDK", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hardhat-kms-imports-"));
    const log = path.join(directory, "imports.log");
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          path.join(here, "../helpers/import-recorder.mjs"),
          path.join(here, "../fixtures/load-config.ts"),
        ],
        { encoding: "utf8", env: { ...process.env, IMPORT_LOG: log }, timeout: 60_000 },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), "3 accounts");

      const imported = readFileSync(log, "utf8").split("\n").filter(Boolean);
      // The recorder works: the plugin and Hardhat itself show up.
      assert.ok(imported.some((specifier) => specifier.startsWith("hardhat/")));
      assert.ok(imported.some((specifier) => specifier.includes("hook-handlers/config.ts")));
      assert.deepEqual(
        imported.filter((specifier) => CLOUD_SDK.test(specifier)),
        [],
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
