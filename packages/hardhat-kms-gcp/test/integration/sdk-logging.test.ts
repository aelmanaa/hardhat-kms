// GOOGLE_SDK_NODE_LOGGING against the installed @google-cloud/kms and google-auth-library: each
// value runs the fixture in its own process, since the libraries read the variable when they load
// and when a client is built. The plugin's warning must appear exactly when a library logs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type { KmsKeyAdapter, KmsKeyConfig } from "hardhat-kms/types";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsGcp from "../../src/index.ts";
import { kmsHandlers } from "../../src/internal/hook-handlers/kms.ts";
import {
  SDK_LOGGING_VARIABLE,
  type SdkLogNamespace,
  sdkLogs,
} from "../../src/internal/sdk-logging.ts";
import { fakeGcpKmsSdk, KEY_VERSION_NAME } from "../helpers/fake-gcp-kms.ts";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/sdk-logging.ts",
);

/** The access token of the fixture's token endpoint. */
const ACCESS_TOKEN = "fixture-access-token";

/** Runs the fixture with the variable set to `value`, or unset, and returns its standard error. */
function run(value: string | undefined): string {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_V8_COVERAGE: "" };
  Reflect.deleteProperty(env, SDK_LOGGING_VARIABLE);
  if (value !== undefined) {
    env[SDK_LOGGING_VARIABLE] = value;
  }
  const result = spawnSync(process.execPath, [fixture], {
    encoding: "utf8",
    env,
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "done\n");
  // A pipe, not a terminal: google-logging-utils prints no colours.
  return result.stderr;
}

describe(`${SDK_LOGGING_VARIABLE} and the installed Google Cloud libraries`, () => {
  // Off, on for both, on for one, and values that turn on nothing: `ALL` is not `all`, and the
  // value is a list of namespaces, which `true` does not match. [value, kms logs, auth logs]
  const cases: [string | undefined, boolean, boolean][] = [
    [undefined, false, false],
    ["", false, false],
    ["*", true, true],
    ["all", true, true],
    ["Kms", true, false],
    ["auth", false, true],
    ["pubsub,a*", false, true],
    ["ALL", false, false],
    ["true", false, false],
  ];
  for (const [value, kms, auth] of cases) {
    const name = value === undefined ? "unset" : JSON.stringify(value);
    it(`warns exactly when a library logs, with the variable ${name}`, () => {
      assert.equal(sdkLogs(value, "kms"), kms);
      assert.equal(sdkLogs(value, "auth"), auth);
      const stderr = run(value);
      // Each library prints its namespace on each line.
      assert.equal(stderr.includes("[kms|"), kms, stderr);
      assert.equal(stderr.includes("[auth|"), auth, stderr);
      // What they print: the key version name in Cloud KMS requests (and in their URLs, which
      // google-auth-library logs), and the access token of a token refresh.
      assert.equal(stderr.includes(KEY_VERSION_NAME), kms || auth);
      assert.equal(stderr.includes(ACCESS_TOKEN), auth);
      // Two adapters and a history read: one warning at most.
      const warnings = stderr
        .split("\n")
        .filter((line) => line.startsWith(`hardhat-kms: ${SDK_LOGGING_VARIABLE} is set`));
      assert.equal(warnings.length, kms || auth ? 1 : 0, stderr);
    });
  }
});

/** A runtime whose Google Cloud handler records which logs each use of a key checks. */
async function runtime(checked: (readonly SdkLogNamespace[])[]) {
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKmsGcp],
    kms: { keys: { deployer: { provider: "gcp", keyVersionName: KEY_VERSION_NAME } } },
  });
  hre.hooks.registerHandlers(
    "kms",
    kmsHandlers(
      undefined,
      async () =>
        await Promise.resolve(fakeGcpKmsSdk({ secretKey: new Uint8Array(32).fill(1) }).sdk),
      async () => await Promise.reject(new Error("no Cloud Logging here")),
      (namespaces) => checked.push(namespaces),
    ),
  );
  const key = hre.config.kms.keys.deployer;
  assert.ok(key);
  return { hre, key };
}

describe("the kms hook handlers and the SDK logging warning", () => {
  it("checks both libraries' logs when it creates a Google Cloud key's adapter", async () => {
    const checked: (readonly SdkLogNamespace[])[] = [];
    const { hre, key } = await runtime(checked);
    await hre.hooks.runHandlerChain(
      "kms",
      "createKeyAdapter",
      [key],
      async (): Promise<KmsKeyAdapter> => await Promise.reject(new Error("unclaimed")),
    );
    assert.deepEqual(checked, [["kms", "auth"]]);
  });

  it("checks google-auth-library's logs only when it reads a Google Cloud key's history", async () => {
    const checked: (readonly SdkLogNamespace[])[] = [];
    const { hre, key } = await runtime(checked);
    await assert.rejects(
      hre.hooks.runHandlerChain(
        "kms",
        "readSignHistory",
        [{ key, since: new Date(0), until: new Date(1000), limit: 1 }],
        async (_context, request: { key: KmsKeyConfig }) =>
          await Promise.reject(new Error(`unclaimed ${request.key.name}`)),
      ),
      { message: "no Cloud Logging here" },
    );
    assert.deepEqual(checked, [["auth"]]);
  });
});
