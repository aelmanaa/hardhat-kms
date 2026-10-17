import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const recorder = pathToFileURL(path.join(here, "../helpers/import-recorder.mjs")).href;

/** The modules that talk to Turnkey: only a Turnkey key's adapter loads them. */
const ADAPTER_MODULES = ["adapter", "client", "stamp", "activity", "payload"].map(
  (name) => `/hardhat-kms-turnkey/src/internal/${name}.ts`,
);

function adapterModules(urls: string[]): string[] {
  return urls.filter((url) => ADAPTER_MODULES.some((module) => url.endsWith(module)));
}

let scratch: string;

/** Runs the fixture under the import recorder and returns the modules it loaded. */
function run(env: Record<string, string>): { urls: string[]; stdout: string } {
  const log = path.join(
    scratch,
    `${Object.values(env).join("-").replaceAll(/\W/g, "") || "plain"}.log`,
  );
  const result = spawnSync(
    process.execPath,
    ["--import", recorder, path.join(here, "../fixtures/load-config.ts")],
    {
      encoding: "utf8",
      env: { ...process.env, ...env, IMPORT_LOG: log },
      timeout: 60_000,
      killSignal: "SIGKILL",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return { urls: readFileSync(log, "utf8").split("\n").filter(Boolean), stdout: result.stdout };
}

describe("adapter loading", () => {
  before(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "hardhat-kms-turnkey-imports-"));
  });

  after(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  for (const hooks of ["sync", "async"]) {
    const recorderEnv: Record<string, string> =
      hooks === "async" ? { IMPORT_RECORDER_ASYNC: "1" } : {};

    it(`loads the plugin and a config with a Turnkey key without the adapter (${hooks} hooks)`, () => {
      const { urls, stdout } = run({ ...recorderEnv, HHKMS_FIXTURE_KEY: "" });

      assert.equal(stdout.trim(), "2 keys");
      assert.ok(
        urls.some((url) => url.includes("/hardhat-kms/dist/src/internal/hook-handlers/config.js")),
        "the recorder saw hardhat-kms",
      );
      assert.ok(
        urls.some((url) => url.endsWith("/hardhat-kms-turnkey/src/index.ts")),
        "the recorder saw the plugin",
      );
      assert.deepEqual(adapterModules(urls), []);
    });

    it(`does not load the adapter for a key of another provider (${hooks} hooks)`, () => {
      const { urls, stdout } = run({ ...recorderEnv, HHKMS_FIXTURE_KEY: "gcp" });

      assert.match(stdout, /^unclaimed$/m);
      assert.ok(
        urls.some((url) => url.endsWith("/hardhat-kms-turnkey/src/internal/hook-handlers/kms.ts")),
        "the key reached the kms hook handler",
      );
      assert.deepEqual(adapterModules(urls), []);
    });
  }

  it("loads the adapter for a Turnkey key", () => {
    const { urls, stdout } = run({ HHKMS_FIXTURE_KEY: "turnkey" });

    assert.match(stdout, /^created turnkey$/m);
    assert.deepEqual(
      ADAPTER_MODULES.filter((module) => !urls.some((url) => url.endsWith(module))),
      [],
    );
  });
});
