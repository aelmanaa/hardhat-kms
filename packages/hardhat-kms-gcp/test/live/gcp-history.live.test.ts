// Runs `kms history` against real Cloud Logging: `pnpm run test:live:gcp`. It is skipped unless
// HARDHAT_KMS_LIVE_GCP_KEY holds the full name of an EC_SIGN_SECP256K1_SHA256 key version, in a
// project with Data Access audit logs on for Cloud KMS, and it uses the developer's Application
// Default Credentials, which need roles/logging.privateLogViewer on the project as well as the
// signing roles. It signs one random digest through the plugin, then reads the key's history
// until that signature's entry appears. A second test signs nothing: it reads the last 7 days with
// the key named by its project id and by its project number, which it looks up through Cloud
// Resource Manager (resourcemanager.projects.get, in roles/logging.privateLogViewer), and checks
// that both reads list the same entries. Nothing it prints names the project, its number, the key
// ring, the key or a principal.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it, mock } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { GoogleAuth } from "google-auth-library";
import type { KmsHistoryReport, KmsKeyConfig } from "hardhat-kms/types";
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsGcp from "../../src/index.ts";

const VARIABLE = "HARDHAT_KMS_LIVE_GCP_KEY";
/** Set by the test to the key's name with the project number, read as a configuration variable. */
const NUMBER_VARIABLE = "HARDHAT_KMS_LIVE_GCP_KEY_BY_NUMBER_390";
const keyVersionName = process.env[VARIABLE]?.trim() ?? "";
const parts =
  /^projects\/([^/]+)\/locations\/([^/]+)\/keyRings\/([^/]+)\/cryptoKeys\/([^/]+)\/cryptoKeyVersions\/(\d+)$/.exec(
    keyVersionName,
  );

/** How long to wait for the entry; Cloud Logging usually delivers it within seconds. */
const POLL_LIMIT_MS = 180_000;
const POLL_INTERVAL_MS = 10_000;
/** The range the read by project number compares: the key signs in every live run. */
const NUMBER_RANGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The key's project number, once the test has looked it up. */
let projectNumber = "";

/** Removes the project, its number, key ring, key names and email addresses from a text. */
function redact(text: string): string {
  let masked = text.replaceAll(keyVersionName, "<key version>");
  for (const part of [...(parts ?? []).slice(1, 5), projectNumber].filter((item) => item !== "")) {
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

async function runtime(variable: string = VARIABLE) {
  return await createHardhatRuntimeEnvironment({
    plugins: [hardhatKmsGcp],
    // From a variable, so that `kms history` masks the key's name without --show-ids.
    kms: { keys: { deployer: { provider: "gcp", keyVersionName: configVariable(variable) } } },
  });
}

/**
 * Looks up the project's number through Cloud Resource Manager: a read, billed to the key's
 * project, where the API must be on. A failure reports only its HTTP status: the server's message
 * can name the credentials' quota project.
 */
async function lookUpProjectNumber(project: string): Promise<string> {
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform.read-only"],
    projectId: project,
  });
  const client = await auth.getClient();
  // Billed to the key's project rather than to the quota project of the credentials file.
  client.quotaProjectId = project;
  // Every status resolves, so that a refusal is reported by its status alone.
  const response = await client.request({
    url: `https://cloudresourcemanager.googleapis.com/v3/projects/${encodeURIComponent(project)}`,
    validateStatus: () => true,
  });
  assert.equal(
    response.status,
    200,
    "looking up the project number failed: the identity needs resourcemanager.projects.get and serviceusage.services.use on the project",
  );
  const data: unknown = response.data;
  const name: unknown = Reflect.get(Object(data), "name");
  const number = typeof name === "string" ? /^projects\/(\d+)$/.exec(name)?.[1] : undefined;
  assert.ok(number !== undefined, "Cloud Resource Manager returned no project number");
  return number;
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
async function history(
  since: string,
  until?: string,
  variable: string = VARIABLE,
): Promise<{ report: KmsHistoryReport; stdout: string }> {
  const hre = await runtime(variable);
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
      until,
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

/** The insert ids of a report's events, in order. */
function insertIds(report: KmsHistoryReport): unknown[] {
  return report.events.map((event) => event.extra?.insertId);
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

    it("lists the same entries when the key names its project by number", async () => {
      // Read only: it signs nothing, and reads a range that ended a minute ago, so that both reads
      // see the same delivered entries.
      assert.ok(parts !== null, `${VARIABLE} must be a full key version name`);
      const [, project = ""] = parts;
      projectNumber = await redacted(async () => await lookUpProjectNumber(project));
      process.env[NUMBER_VARIABLE] = keyVersionName.replace(
        `projects/${project}/`,
        `projects/${projectNumber}/`,
      );
      try {
        const now = Math.floor(Date.now() / 1000) * 1000;
        const since = new Date(now - NUMBER_RANGE_MS).toISOString();
        const until = new Date(now - 60_000).toISOString();
        const byId = await redacted(async () => await history(since, until));
        const byNumber = await redacted(async () => await history(since, until, NUMBER_VARIABLE));
        assert.ok(
          byId.report.events.length > 0,
          "the key has no sign entries in the last 7 days to compare",
        );
        assert.deepEqual(insertIds(byNumber.report), insertIds(byId.report));
        assert.equal(byNumber.report.truncated, byId.report.truncated);
        // A federated principal's subject can hold a project number; principals show as logged.
        const outsidePrincipals = byNumber.stdout.replaceAll(/"principal(Subject)?": "[^"]*"/g, "");
        assert.ok(
          !outsidePrincipals.includes(projectNumber),
          "the project number reached the output",
        );
      } finally {
        Reflect.deleteProperty(process.env, NUMBER_VARIABLE);
      }
    });
  },
);
