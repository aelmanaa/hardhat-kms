// Runs `kms history` against a real Log Analytics workspace: `pnpm run test:live:azure`. It is
// skipped unless HARDHAT_KMS_LIVE_AZURE_KEY_ID holds the versioned URL of an EC P-256K key, as for
// the adapter's live test, and HARDHAT_KMS_LIVE_AZURE_WORKSPACE_ID holds the id of the workspace
// that the vault's diagnostic setting sends AuditEvent logs to, in resource-specific mode. It uses
// the plugin's credential chain (`az login` is enough), which needs read access to the workspace
// as well as the signing role. It signs one digest through the plugin and one with the Key Vault
// SDK directly, keeping the second call's x-ms-request-id, then reads the key's history until both
// KeySign rows appear: Key Vault documents up to 10 minutes. Nothing it prints names the vault,
// the key, the workspace or a principal.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it, mock } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import * as identity from "@azure/identity";
import { CryptographyClient } from "@azure/keyvault-keys";
import type { KmsHistoryReport, KmsKeyConfig } from "hardhat-kms/types";
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsAzure from "../../src/index.ts";
import { createAzureCredential } from "../../src/internal/credential.ts";

const KEY_VARIABLE = "HARDHAT_KMS_LIVE_AZURE_KEY_ID";
const WORKSPACE_VARIABLE = "HARDHAT_KMS_LIVE_AZURE_WORKSPACE_ID";
const keyId = process.env[KEY_VARIABLE]?.trim() ?? "";
const workspaceId = process.env[WORKSPACE_VARIABLE]?.trim() ?? "";
const match = /^https:\/\/([^/]+)\/keys\/([^/]+)\/([^/]+)$/.exec(keyId);

/** How long to wait for the rows: Key Vault documents "10 minutes (at most)". */
const POLL_LIMIT_MS = 12 * 60_000;
const POLL_INTERVAL_MS = 30_000;

/** Removes the vault, key, workspace, GUIDs and email addresses from a text. */
function redact(text: string): string {
  let masked = text;
  for (const secret of [keyId, workspaceId, ...(match ?? []).slice(1)]) {
    if (secret !== "") {
      masked = masked.replaceAll(secret, "<redacted>");
    }
  }
  return masked
    .replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<guid>")
    .replaceAll(/[\w.+#-]+@[\w.-]+/g, "<email>");
}

/**
 * Runs `step` and fails with any error's name and message, redacted. The original error is not
 * passed on, since node:test would print it.
 */
async function redacted<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    const name = error instanceof Error ? error.name : typeof error;
    const message = error instanceof Error ? error.message : String(error);
    return assert.fail(redact(`${name}: ${message}`));
  }
}

async function runtime() {
  return await createHardhatRuntimeEnvironment({
    plugins: [hardhatKmsAzure],
    // From variables, so that `kms history` masks the key and the workspace without --show-ids.
    kms: {
      keys: { deployer: { provider: "azure", keyId: configVariable(KEY_VARIABLE) } },
      audit: { azure: { workspaceId: configVariable(WORKSPACE_VARIABLE) } },
    },
  });
}

/** Signs a random digest with the key through the plugin's adapter, as a signer would. */
async function signThroughPlugin(): Promise<void> {
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
    await adapter.signDigest?.({ digest: new Uint8Array(randomBytes(32)) }, context);
  } finally {
    await adapter.close?.();
  }
}

/**
 * Signs a random digest with the Key Vault SDK, outside the plugin, and returns the request ids
 * of the sign call: the server's `x-ms-request-id` and the client's `x-ms-client-request-id`.
 */
async function signWithSdk(): Promise<{ server: string; client: string }> {
  const client = new CryptographyClient(keyId, createAzureCredential(identity, undefined), {
    userAgentOptions: { userAgentPrefix: "hardhat-kms-live-history-sdk" },
  });
  let ids: { server: string; client: string } | undefined;
  await client.sign("ES256K", new Uint8Array(randomBytes(32)), {
    onResponse: (response) => {
      ids = {
        server: response.headers.get("x-ms-request-id") ?? "",
        client: response.request.headers.get("x-ms-client-request-id") ?? "",
      };
    },
  });
  assert.ok(ids !== undefined && ids.server !== "" && ids.client !== "", "no request ids");
  return ids;
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
  "kms history on a real Log Analytics workspace",
  { skip: keyId === "" || workspaceId === "" },
  () => {
    it(
      "lists the KeySign rows of a plugin signature and an SDK signature",
      { timeout: POLL_LIMIT_MS + 120_000 },
      async (t) => {
        assert.ok(match !== null, `${KEY_VARIABLE} must be https://<vault>/keys/<name>/<version>`);
        const since = new Date(Date.now() - 60_000).toISOString();
        const signedAt = Date.now();
        await redacted(signThroughPlugin);
        const ids = await redacted(signWithSdk);

        type Event = KmsHistoryReport["events"][number];
        let plugin: Event | undefined;
        let sdk: Event | undefined;
        let last: { report: KmsHistoryReport; stdout: string } | undefined;
        let reads = 0;
        while (
          (plugin === undefined || sdk === undefined) &&
          Date.now() - signedAt < POLL_LIMIT_MS
        ) {
          if (reads > 0) {
            await sleep(POLL_INTERVAL_MS);
          }
          last = await redacted(async () => await history(since));
          reads++;
          const events = last.report.events;
          plugin = events.find((event) => event.userAgent?.startsWith("hardhat-kms/") === true);
          sdk = events.find((event) => event.requestId?.toLowerCase() === ids.server.toLowerCase());
        }
        t.diagnostic(
          `read ${reads} time(s) over ${Math.round((Date.now() - signedAt) / 1000)} s: plugin row ${
            plugin === undefined ? "missing" : "found"
          }, SDK row ${sdk === undefined ? "missing" : "found"}`,
        );
        assert.ok(plugin, "no KeySign row with the plugin's user agent");
        assert.ok(sdk, "no KeySign row whose request id is the SDK call's x-ms-request-id");
        assert.ok(last);

        const { report, stdout } = last;
        assert.equal(report.source, "log-analytics");
        assert.deepEqual(report.notLogged, ["digest"]);
        for (const event of [plugin, sdk]) {
          assert.equal(event.operation, "KeySign");
          assert.equal(event.outcome, "success");
          assert.equal(event.keyVersion, match[3]);
          assert.equal(event.digest, null);
          assert.equal(event.keyResource, `azure:<${KEY_VARIABLE}>`);
          assert.ok(event.principal !== null, "the row has no principal");
          assert.ok(event.sourceIp !== null, "the row has no source IP");
          assert.ok(event.requestId !== null, "the row has no request id");
        }
        assert.match(
          plugin.userAgent ?? "",
          /^hardhat-kms\/\d+\.\d+\.\d+ azsdk-js-keyvault-keys\//,
        );
        // Key Vault logs the server's request id, never the client's.
        assert.ok(
          !report.events.some(
            (event) => event.requestId?.toLowerCase() === ids.client.toLowerCase(),
          ),
          "a row's request id is the client request id",
        );

        // Without --show-ids, the vault, key, workspace and the claim ids appear nowhere but in
        // principals, which are shown as logged.
        const outsidePrincipals = stdout.replaceAll(/"principal": "[^"]*"/g, "");
        const [, host = "", name = ""] = match;
        for (const secret of [keyId, workspaceId, host, `/keys/${name}`]) {
          assert.ok(!outsidePrincipals.includes(secret), "an id reached the output");
        }
        assert.match(stdout, /"scope": "workspace <hidden>, /);
      },
    );
  },
);
