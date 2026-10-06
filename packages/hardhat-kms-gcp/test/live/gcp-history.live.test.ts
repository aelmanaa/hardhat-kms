// Runs `kms history` against real Cloud Logging: `pnpm run test:live:gcp`. It is skipped unless
// HARDHAT_KMS_LIVE_GCP_KEY holds the full name of an EC_SIGN_SECP256K1_SHA256 key version, in a
// project with Data Access audit logs on for Cloud KMS, and it uses the developer's Application
// Default Credentials, which need roles/logging.privateLogViewer on the project as well as the
// signing roles. It signs one random digest through the plugin, then reads the key's history
// until that signature's entry appears. Nothing it prints names the project, the key ring, the key
// or a principal.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it, mock } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import type { KmsHistoryReport, KmsKeyConfig } from "hardhat-kms/types";
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsGcp from "../../src/index.ts";

const VARIABLE = "HARDHAT_KMS_LIVE_GCP_KEY";
const keyVersionName = process.env[VARIABLE]?.trim() ?? "";
const parts =
  /^projects\/([^/]+)\/locations\/([^/]+)\/keyRings\/([^/]+)\/cryptoKeys\/([^/]+)\/cryptoKeyVersions\/(\d+)$/.exec(
    keyVersionName,
  );

/** How long to wait for the entry; Cloud Logging usually delivers it within seconds. */
const POLL_LIMIT_MS = 180_000;
const POLL_INTERVAL_MS = 10_000;

/** Removes the project, key ring, key names and email addresses from a text. */
function redact(text: string): string {
  let masked = text.replaceAll(keyVersionName, "<key version>");
  for (const part of (parts ?? []).slice(1, 5)) {
    masked = masked.replaceAll(part, "<redacted>");
  }
  return masked.replaceAll(/[\w.+-]+@[\w.-]+/g, "<email>");
}

/** Runs `step`, and rethrows a failure with the names removed and no cause, which would print. */
async function redacted<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    const name = error instanceof Error ? error.name : typeof error;
    const message = error instanceof Error ? error.message : String(error);
    // oxlint-disable-next-line eslint/preserve-caught-error -- the cause would be printed unredacted
    throw new Error(redact(`${name}: ${message}`));
  }
}

async function runtime() {
  return await createHardhatRuntimeEnvironment({
    plugins: [hardhatKmsGcp],
    // From a variable, so that `kms history` masks the key's name without --show-ids.
    kms: { keys: { deployer: { provider: "gcp", keyVersionName: configVariable(VARIABLE) } } },
  });
}

/** Signs a digest with the key through the plugin's adapter, as a signer would. */
async function sign(digest: Uint8Array): Promise<void> {
  const hre = await runtime();
  const key = hre.config.kms.keys.deployer;
  assert.ok(key);
  const adapter = await hre.hooks.runHandlerChain(
    "kms",
    "createKeyAdapter",
    [key],
    async (_context, rest: KmsKeyConfig) =>
      await Promise.reject(new Error(`unclaimed ${rest.displayId}`)),
  );
  const context = {
    signal: new AbortController().signal,
    displayMessage: async () => {},
    requestId: "live-history",
  };
  try {
    await adapter.getPublicKey?.(context);
    await adapter.signDigest?.({ digest }, context);
  } finally {
    await adapter.close?.();
  }
}

function isReport(value: unknown): value is KmsHistoryReport {
  return typeof value === "object" && value !== null && Reflect.get(value, "version") === 1;
}

/** Runs `kms history deployer --json`, capturing both streams so that nothing is printed. */
async function history(since: string): Promise<{ report: KmsHistoryReport; stdout: string }> {
  const hre = await runtime();
  let stdout = "";
  const write = mock.method(process.stdout, "write", (chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  const writeError = mock.method(process.stderr, "write", () => true);
  try {
    const result: unknown = await hre.tasks.getTask(["kms", "history"]).run({
      key: "deployer",
      since,
      until: undefined,
      limit: 1000,
      json: true,
      showIds: false,
    });
    assert.ok(isReport(result), "kms history returned no report");
    return { report: result, stdout };
  } finally {
    write.mock.restore();
    writeError.mock.restore();
  }
}

describe(
  "kms history on real Cloud Logging",
  { skip: keyVersionName === "", timeout: POLL_LIMIT_MS + 60_000 },
  () => {
    it("lists the AsymmetricSign entry of a signature the plugin just made", async (t) => {
      assert.ok(parts !== null, `${VARIABLE} must be a full key version name`);
      const digest = new Uint8Array(randomBytes(32));
      const expected = `0x${Buffer.from(digest).toString("hex")}`;
      const since = new Date(Date.now() - 60_000).toISOString();
      const signedAt = Date.now();
      await redacted(async () => {
        await sign(digest);
      });

      let found: KmsHistoryReport["events"][number] | undefined;
      let last: { report: KmsHistoryReport; stdout: string } | undefined;
      let reads = 0;
      while (found === undefined && Date.now() - signedAt < POLL_LIMIT_MS) {
        last = await redacted(async () => await history(since));
        reads++;
        found = last.report.events.find((event) => event.digest === expected);
        if (found === undefined) {
          await sleep(POLL_INTERVAL_MS);
        }
      }
      assert.ok(found, `no entry with the signed digest after ${reads} reads`);
      assert.ok(last);
      t.diagnostic(
        `found after ${Math.round((Date.now() - signedAt) / 1000)} s and ${reads} read(s)`,
      );

      const { report, stdout } = last;
      assert.equal(report.source, "cloud-logging");
      assert.deepEqual(report.notLogged, ["requestId"]);
      assert.equal(found.operation, "AsymmetricSign");
      assert.equal(found.outcome, "success");
      assert.equal(found.error, null);
      assert.equal(found.keyVersion, parts[5]);
      assert.equal(found.requestId, null);
      assert.match(found.userAgent ?? "", /^hardhat-kms\/\d+\.\d+\.\d+ /);
      assert.ok(found.principal !== null, "the entry has no principal");
      assert.ok(found.sourceIp !== null, "the entry has no source IP");
      assert.equal(typeof found.extra?.insertId, "string");
      assert.equal(found.keyResource, "gcp:<HARDHAT_KMS_LIVE_GCP_KEY>");

      // Without --show-ids, the key's name and parts appear nowhere but in principals, which are
      // shown as logged.
      const outsidePrincipals = stdout.replaceAll(/"principal(Subject)?": "[^"]*"/g, "");
      const [, project = "", , keyRing = "", key = ""] = parts;
      for (const part of [keyVersionName, project, keyRing, key]) {
        assert.ok(!outsidePrincipals.includes(part), "a key id reached the output");
      }
    });
  },
);
