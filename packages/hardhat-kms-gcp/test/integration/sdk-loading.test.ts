import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const recorder = pathToFileURL(path.join(here, "../helpers/import-recorder.mjs")).href;

// The Google Cloud SDK and the packages it pulls in.
const sdkPackages = [
  "@google-cloud/",
  "google-gax/",
  "google-auth-library/",
  "gaxios/",
  "@grpc/",
  "protobufjs/",
];

function sdkModules(urls: string[]): string[] {
  return urls.filter((url) => sdkPackages.some((name) => url.includes(`/node_modules/${name}`)));
}

let scratch: string;

/** Runs the fixture under the import recorder and returns the URLs of the modules it loaded. */
function run(env: Record<string, string>): { urls: string[]; stdout: string } {
  const log = path.join(scratch, `${Object.values(env).join("-").replaceAll(/\W/g, "")}.log`);
  const result = spawnSync(
    process.execPath,
    ["--import", recorder, path.join(here, "../fixtures/load-config.ts")],
    {
      encoding: "utf8",
      env: { ...process.env, ...env, IMPORT_LOG: log },
      timeout: 60_000,
      // A stuck child must not outlive the test: SIGTERM can be ignored while hooks are loading.
      killSignal: "SIGKILL",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return { urls: readFileSync(log, "utf8").split("\n").filter(Boolean), stdout: result.stdout };
}

describe("SDK loading", () => {
  before(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "hardhat-kms-gcp-imports-"));
  });

  after(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  // "sync" uses module.registerHooks where Node has it; "async" forces the fallback older Node uses.
  for (const hooks of ["sync", "async"]) {
    const recorderEnv: Record<string, string> =
      hooks === "async" ? { IMPORT_RECORDER_ASYNC: "1" } : {};

    it(`loads the plugin and resolves the config without loading the Google Cloud SDK (${hooks} hooks)`, () => {
      const { urls, stdout } = run({ ...recorderEnv, HHKMS_FIXTURE_KEY: "" });

      assert.equal(stdout.trim(), "3 accounts");
      assert.ok(
        urls.some((url) => url.includes("/hardhat-kms/dist/src/internal/hook-handlers/config.js")),
        "the recorder saw hardhat-kms",
      );
      assert.deepEqual(sdkModules(urls), []);
    });

    it(`does not load the Google Cloud SDK for keys of other providers (${hooks} hooks)`, () => {
      const { urls, stdout } = run({ ...recorderEnv, HHKMS_FIXTURE_KEY: "aws" });

      assert.match(stdout, /^unclaimed$/m);
      assert.ok(
        urls.some((url) => url.includes("/hardhat-kms-gcp/src/internal/hook-handlers/kms.ts")),
        "the recorder saw the kms hook handler",
      );
      assert.deepEqual(sdkModules(urls), []);
    });

    it(`loads the Google Cloud SDK once a Google Cloud key's adapter is created (positive control, ${hooks} hooks)`, () => {
      const { urls, stdout } = run({ ...recorderEnv, HHKMS_FIXTURE_KEY: "gcp" });

      assert.match(stdout, /^created gcp adapter$/m);
      assert.ok(
        urls.some((url) => url.includes("/node_modules/@google-cloud/kms/")),
        "the SDK was not recorded",
      );
    });
  }
});
