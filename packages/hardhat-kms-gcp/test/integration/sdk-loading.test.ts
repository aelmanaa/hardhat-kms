import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// The history reader's modules, which only `kms history` on a Google Cloud key loads.
const historyModules = ["/src/internal/history.ts", "/src/internal/logging-client.ts"];

function readerModules(urls: string[]): string[] {
  return urls.filter((url) =>
    historyModules.some((name) => url.includes(`/hardhat-kms-gcp${name}`)),
  );
}

function sdkModules(urls: string[]): string[] {
  return urls.filter(
    (url) =>
      sdkPackages.some((name) => url.includes(`/node_modules/${name}`)) ||
      historyModules.some((name) => url.includes(`/hardhat-kms-gcp${name}`)),
  );
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
      // Defining the kms tasks loads none of their actions.
      assert.deepEqual(
        urls.filter((url) => url.includes("/hardhat-kms/dist/src/internal/tasks/")),
        [],
      );
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

    for (const task of ["address", "public-key", "sign-auth", "sign-tx", "verify", "history"]) {
      it(`runs kms ${task} on a key of another provider without loading the Google Cloud SDK (${hooks} hooks)`, () => {
        const { urls, stdout } = run({
          ...recorderEnv,
          HHKMS_FIXTURE_KEY: "aws",
          HHKMS_FIXTURE_TASK: task,
          ...(task === "sign-tx" ? { HARDHAT_NETWORK: "sepolia" } : {}),
        });

        assert.match(stdout, /^task failed$/m);
        if (task === "sign-tx") {
          assert.match(stdout, /^sign-tx reached the key$/m);
        }
        assert.ok(
          urls.some((url) => url.includes(`/hardhat-kms/dist/src/internal/tasks/${task}.js`)),
          "the recorder saw the task action",
        );
        assert.ok(
          urls.some((url) => url.includes("/hardhat-kms-gcp/src/internal/hook-handlers/kms.ts")),
          "the task reached the kms hook",
        );
        assert.deepEqual(sdkModules(urls), []);
      });
    }

    it(`runs kms accounts on the other providers' keys without loading the Google Cloud SDK (${hooks} hooks)`, () => {
      const { urls, stdout } = run({
        ...recorderEnv,
        HHKMS_FIXTURE_KEY: "",
        HHKMS_FIXTURE_SKIP: "gcp",
        HHKMS_FIXTURE_TASK: "accounts",
      });

      // The other providers' packages are not installed here, so both keys fail, and are listed.
      assert.match(stdout, /^accounts task failed$/m);
      assert.match(stdout, /^aws .* FAILED /m);
      assert.match(stdout, /^azure .* FAILED /m);
      assert.ok(
        urls.some((url) => url.includes("/hardhat-kms/dist/src/internal/tasks/accounts.js")),
        "the recorder saw the task action",
      );
      assert.deepEqual(sdkModules(urls), []);
    });

    it(`runs kms address on a Google Cloud key without loading the history reader (${hooks} hooks)`, () => {
      // Placeholder user credentials, whose token refresh goes to a proxy that refuses it, so
      // the task fails without a request leaving the machine.
      const credentials = path.join(scratch, "placeholder-adc.json");
      writeFileSync(
        credentials,
        JSON.stringify({
          type: "authorized_user",
          client_id: "placeholder",
          client_secret: "placeholder",
          refresh_token: "placeholder",
        }),
      );
      const { urls, stdout } = run({
        ...recorderEnv,
        HHKMS_FIXTURE_KEY: "gcp",
        HHKMS_FIXTURE_TASK: "address",
        GOOGLE_APPLICATION_CREDENTIALS: credentials,
        HTTPS_PROXY: "http://127.0.0.1:1",
        https_proxy: "http://127.0.0.1:1",
        NO_PROXY: "",
        no_proxy: "",
      });

      assert.match(stdout, /^task failed$/m);
      assert.ok(
        urls.some((url) => url.includes("/node_modules/@google-cloud/kms/")),
        "the task did not reach the SDK",
      );
      assert.deepEqual(readerModules(urls), []);
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
