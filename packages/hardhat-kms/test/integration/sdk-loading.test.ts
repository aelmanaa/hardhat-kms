import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BUILTIN_PROVIDERS } from "../../src/internal/providers/registry.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const recorder = pathToFileURL(path.join(here, "../helpers/import-recorder.mjs")).href;

// Every SDK the built-in providers declare, plus the packages those SDKs pull in.
const cloudPackages = [
  ...Object.values(BUILTIN_PROVIDERS).flatMap((provider) =>
    provider.sdks.map((sdk) => sdk.packageName),
  ),
  "@smithy/",
  "@aws-crypto/",
  "google-gax",
  "@grpc/",
  "@azure-rest/",
];

function cloudModules(urls: string[]): string[] {
  return urls.filter((url) => cloudPackages.some((name) => url.includes(`/node_modules/${name}`)));
}

let scratch: string;

/** Runs a fixture under the import recorder and returns the URLs of the modules it loaded. */
function run(
  fixture: string,
  env: Record<string, string> = {},
): { urls: string[]; stdout: string } {
  const log = path.join(
    scratch,
    `${fixture}-${Object.values(env).join("-").replaceAll(/\W/g, "")}.log`,
  );
  const result = spawnSync(
    process.execPath,
    ["--import", recorder, path.join(here, "../fixtures", fixture)],
    {
      encoding: "utf8",
      env: { ...process.env, ...env, IMPORT_LOG: log },
      timeout: 60_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return { urls: readFileSync(log, "utf8").split("\n").filter(Boolean), stdout: result.stdout };
}

describe("SDK loading", () => {
  before(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "hardhat-kms-imports-"));
    // A project with a fake AWS SDK, for the recorder's positive controls.
    const sdk = path.join(scratch, "project", "node_modules", "@aws-sdk", "client-kms");
    mkdirSync(sdk, { recursive: true });
    writeFileSync(
      path.join(scratch, "project", "package.json"),
      JSON.stringify({ name: "project" }),
    );
    writeFileSync(
      path.join(sdk, "package.json"),
      JSON.stringify({ name: "@aws-sdk/client-kms", version: "3.0.0" }),
    );
    writeFileSync(path.join(sdk, "index.js"), "exports.fake = true;");
  });

  after(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("covers every SDK the built-in providers declare", () => {
    for (const provider of Object.values(BUILTIN_PROVIDERS)) {
      for (const sdk of provider.sdks) {
        assert.equal(
          cloudModules([`file:///x/node_modules/${sdk.packageName}/index.js`]).length,
          1,
          sdk.packageName,
        );
      }
    }
  });

  // "sync" uses module.registerHooks where Node has it; "async" forces the fallback older Node uses.
  for (const hooks of ["sync", "async"]) {
    const recorderEnv: Record<string, string> =
      hooks === "async" ? { IMPORT_RECORDER_ASYNC: "1" } : {};

    it(`notices an SDK loaded through loadSdk or require (positive controls, ${hooks} hooks)`, () => {
      const project = path.join(scratch, "project");
      for (const mode of ["loadSdk", "require"]) {
        const { urls } = run("load-sdk.ts", {
          ...recorderEnv,
          HHKMS_FIXTURE_PROJECT: project,
          HHKMS_FIXTURE_MODE: mode,
        });

        assert.notDeepEqual(cloudModules(urls), [], `${mode} was not recorded`);
      }
    });

    it(`loads the plugin and every provider's config without loading a cloud SDK (${hooks} hooks)`, () => {
      const { urls, stdout } = run("load-config.ts", recorderEnv);

      assert.equal(stdout.trim(), "3 accounts");
      assert.ok(
        urls.some((url) => url.includes("/hook-handlers/config.ts")),
        "the recorder saw the plugin",
      );
      assert.deepEqual(cloudModules(urls), []);
    });
  }
});
