import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, beforeEach, describe, it, mock } from "node:test";

import { createHttpHeaders } from "@azure/core-rest-pipeline";
import type { AzureKmsKeyConfig, KmsAuditUserConfig, KmsHistoryReport } from "hardhat-kms/types";
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsAzure from "../../src/index.ts";
import { readAzureSignHistory } from "../../src/internal/history.ts";
import { kmsHandlers } from "../../src/internal/hook-handlers/kms.ts";
import { LOG_ANALYTICS_SCOPE, logAnalyticsQuery } from "../../src/internal/log-analytics.ts";
import {
  ASSIGNMENT_ID,
  CLI_APP_ID,
  FAILED_SIGN,
  KEY_NAME,
  KEY_URL,
  NO_TABLE_ERROR,
  PLUGIN_SIGN,
  queryBody,
  REQUEST_ID,
  SERVICE_PRINCIPAL_SIGN,
  USER,
  USER_OBJECT_ID,
  VAULT_HOST,
  VERSION_1,
  WORKSPACE_ID,
} from "../fixtures/log-analytics-rows.ts";
import { type LogAnalyticsHttp, logAnalyticsHttp } from "../helpers/log-analytics-http.ts";

const ownVersion = String(
  Reflect.get(Object(createRequire(import.meta.url)("hardhat-kms-azure/package.json")), "version"),
);

// A range that holds the recorded rows, and is in the past.
const RANGE = { since: "2026-10-01T10:00:00Z", until: "2026-10-02T10:10:00Z" };

let endpoint: LogAnalyticsHttp;

interface HistoryRun {
  report: KmsHistoryReport | undefined;
  error: unknown;
  stdout: string;
  stderr: string;
}

function isReport(value: unknown): value is KmsHistoryReport {
  return typeof value === "object" && value !== null && Reflect.get(value, "version") === 1;
}

/** Runs `kms history` through the plugin, with its Log Analytics query on the fake endpoint. */
async function history(
  args: { key?: string; limit?: number; showIds?: boolean; json?: boolean } = {},
  options: { audit?: KmsAuditUserConfig; version?: string } = {},
): Promise<HistoryRun> {
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKmsAzure],
    kms: {
      keys: {
        // From variables, so that the key's display id names the variable, not the vault.
        deployer: { provider: "azure", keyId: configVariable("HHKMS_HISTORY_AZURE_KEY") },
        amazon: { provider: "aws", keyId: "alias/deployer", region: "eu-west-1" },
      },
      audit: options.audit ?? {
        azure: { workspaceId: configVariable("HHKMS_HISTORY_AZURE_WORKSPACE") },
      },
    },
  });
  // Run-time handlers run first: the plugin's own handler, with the query on the fake endpoint.
  hre.hooks.registerHandlers(
    "kms",
    kmsHandlers(options.version ?? ownVersion, undefined, async (userAgent) =>
      logAnalyticsQuery(endpoint.credential, userAgent, { httpClient: endpoint.httpClient }),
    ),
  );
  let stdout = "";
  let stderr = "";
  const write = mock.method(process.stdout, "write", (chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  const writeError = mock.method(process.stderr, "write", (chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  let result: unknown;
  let error: unknown;
  try {
    result = await hre.tasks.getTask(["kms", "history"]).run({
      key: args.key ?? "deployer",
      ...RANGE,
      limit: args.limit ?? 100,
      json: args.json ?? true,
      showIds: args.showIds ?? false,
    });
  } catch (thrown) {
    error = thrown;
  } finally {
    write.mock.restore();
    writeError.mock.restore();
  }
  return { report: isReport(result) ? result : undefined, error, stdout, stderr };
}

const rows = (...items: Parameters<typeof queryBody>[0]) => ({
  status: 200,
  body: queryBody(items),
});

describe("kms history on an Azure key", () => {
  before(() => {
    process.env.HHKMS_HISTORY_AZURE_KEY = `${KEY_URL}/${VERSION_1}`;
    process.env.HHKMS_HISTORY_AZURE_WORKSPACE = WORKSPACE_ID;
  });

  after(() => {
    delete process.env.HHKMS_HISTORY_AZURE_KEY;
    delete process.env.HHKMS_HISTORY_AZURE_WORKSPACE;
  });

  beforeEach(() => {
    endpoint = logAnalyticsHttp();
  });

  it("queries the workspace and shows the KeySign rows masked", async () => {
    endpoint.answers.push(rows(FAILED_SIGN, PLUGIN_SIGN, SERVICE_PRINCIPAL_SIGN));
    const { report, error, stdout, stderr } = await history();
    assert.equal(error, undefined);
    assert.ok(report);

    const [request] = endpoint.requests;
    assert.equal(endpoint.requests.length, 1);
    assert.equal(request?.method, "POST");
    assert.equal(request?.url, `https://api.loganalytics.io/v1/workspaces/${WORKSPACE_ID}/query`);
    assert.equal(request?.authorization, "Bearer fake-log-analytics-token");
    assert.deepEqual(endpoint.scopes, [LOG_ANALYTICS_SCOPE]);
    assert.ok(
      String(request?.userAgent).startsWith(`hardhat-kms/${ownVersion} `),
      "the read carries the plugin's user agent",
    );
    const query = String(Reflect.get(Object(request?.body), "query"));
    assert.match(query, /^AZKVAuditLogs\n/);
    assert.match(query, new RegExp(`=~ "${VAULT_HOST.replaceAll(".", "\\.")}"`));
    assert.match(query, new RegExp(`=~ "${KEY_NAME}"`));
    // The configured version is pinned, but the history covers every version.
    assert.doesNotMatch(query, new RegExp(VERSION_1));

    assert.equal(report.source, "log-analytics");
    assert.deepEqual(report.notLogged, ["digest"]);
    assert.deepEqual(
      report.events.map((event) => [event.outcome, event.requestId, event.error?.code ?? null]),
      [
        ["failed", "00000000-0000-4000-8000-0000000000a2", "Bad Request"],
        ["success", REQUEST_ID, null],
        ["success", "00000000-0000-4000-8000-0000000000a3", null],
      ],
    );
    assert.equal(report.events[1]?.principal, USER);
    assert.equal(report.events[1]?.keyVersion, VERSION_1);
    assert.equal(report.events[1]?.keyResource, "azure:<HHKMS_HISTORY_AZURE_KEY>");
    // Without --show-ids, no workspace, vault, object id, app id or error message is printed.
    assert.match(stdout, /"scope": "workspace <hidden>, AZKVAuditLogs in one Log Analytics/);
    for (const text of [stdout, stderr]) {
      for (const hidden of [WORKSPACE_ID, VAULT_HOST, USER_OBJECT_ID, CLI_APP_ID, ASSIGNMENT_ID]) {
        assert.ok(!text.includes(hidden), `the output shows ${hidden}`);
      }
    }
    assert.doesNotMatch(stdout, /incompatible/);
    assert.match(stdout, /"userAgent": "hardhat-kms\/0\.0\.0 azsdk-js-keyvault-keys/);
    // Events were found, so the core does not say that logging may be off.
    assert.ok(!report.notes.some((note) => note.code === "logging-not-confirmed"));
  });

  it("shows the ids and the error message with --show-ids", async () => {
    endpoint.answers.push(rows(FAILED_SIGN));
    const { report, stdout } = await history({ showIds: true });
    assert.equal(report?.events[0]?.keyResource, `${KEY_URL}/${VERSION_1}`);
    assert.match(String(report?.events[0]?.error?.message), /incompatible/);
    assert.equal(report?.events[0]?.extra.objectId, USER_OBJECT_ID);
    assert.match(stdout, new RegExp(WORKSPACE_ID));
  });

  it("prints the table, with the request id and the key version", async () => {
    endpoint.answers.push(rows(PLUGIN_SIGN));
    const { stdout } = await history({ json: false });
    assert.match(stdout, /from log-analytics/);
    assert.match(stdout, /KeySign/);
    assert.match(stdout, new RegExp(REQUEST_ID));
    assert.match(stdout, new RegExp(VERSION_1));
    assert.doesNotMatch(stdout, new RegExp(VAULT_HOST));
  });

  it("marks a result over the limit as truncated", async () => {
    endpoint.answers.push(rows(FAILED_SIGN, PLUGIN_SIGN));
    const { report } = await history({ limit: 1 });
    assert.match(String(Reflect.get(Object(endpoint.requests[0]?.body), "query")), /\| take 2\n/);
    assert.equal(report?.events.length, 1);
    assert.equal(report?.truncatedReason, "limit");
  });

  it("says an empty history proves little, and how to set up the logs", async () => {
    endpoint.answers.push(rows());
    const { report, stderr } = await history();
    assert.deepEqual(report?.events, []);
    assert.match(stderr, /The log returned no sign events in this range/);
    assert.match(stderr, /diagnostic setting on the vault sends the AuditEvent category/);
  });

  it("retries a throttled query after Retry-After, then reads it", async () => {
    endpoint.answers.push(
      { status: 429, body: { error: { code: "ThrottledError" } }, headers: { "Retry-After": "0" } },
      rows(PLUGIN_SIGN),
    );
    const { report, error } = await history();
    assert.equal(error, undefined);
    assert.equal(endpoint.requests.length, 2);
    assert.equal(report?.events.length, 1);
  });

  it("fails with the documented limit when the query stays throttled", async () => {
    const throttled = { status: 429, headers: { "Retry-After": "0" } };
    endpoint.answers.push(throttled, throttled, throttled);
    const { error, stdout } = await history();
    assert.ok(error instanceof Error);
    assert.match(error.message, /200 per 30 seconds/);
    // The first try and two retries.
    assert.equal(endpoint.requests.length, 3);
    assert.equal(stdout, "");
  });

  it("fails with both permissions when the read is refused", async () => {
    endpoint.answers.push({
      status: 403,
      body: { error: { code: "InsufficientAccessError", message: `on ${VAULT_HOST}` } },
    });
    const { error } = await history();
    assert.ok(error instanceof Error);
    assert.match(error.message, /workspaces\/query\/read and .*\/query\/AZKVAuditLogs\/read/);
    assert.doesNotMatch(error.message, new RegExp(VAULT_HOST));
  });

  it("fails when the workspace has no AZKVAuditLogs table", async () => {
    endpoint.answers.push({ status: 400, body: NO_TABLE_ERROR });
    const { error, report } = await history();
    assert.equal(report, undefined);
    assert.ok(error instanceof Error);
    assert.match(error.message, /has no AZKVAuditLogs table/);
  });

  it("fails, naming the setting, without kms.audit.azure.workspaceId", async () => {
    const { error } = await history({}, { audit: {} });
    assert.ok(error instanceof Error);
    assert.match(error.message, /kms\.audit\.azure\.workspaceId is not set/);
    assert.equal(endpoint.requests.length, 0);
  });

  it("refuses a workspace variable that does not hold a GUID", async () => {
    process.env.HHKMS_HISTORY_AZURE_WORKSPACE = "my-workspace";
    try {
      const { error } = await history();
      assert.ok(error instanceof Error);
      assert.match(error.message, /workspaceId/);
      assert.equal(endpoint.requests.length, 0);
    } finally {
      process.env.HHKMS_HISTORY_AZURE_WORKSPACE = WORKSPACE_ID;
    }
  });

  it("passes another provider's key on", async () => {
    const { error } = await history({ key: "amazon" });
    assert.ok(error instanceof Error);
    assert.match(error.message, /hardhat-kms-aws/);
    assert.equal(endpoint.requests.length, 0);
  });

  it("checks that hardhat-kms is the same version first", async () => {
    const { error } = await history({}, { version: "9.9.9" });
    assert.ok(error instanceof Error);
    assert.match(error.message, /9\.9\.9/);
    assert.equal(endpoint.requests.length, 0);
  });

  it("stops the query when the signal aborts", async () => {
    const controller = new AbortController();
    const hanging = logAnalyticsHttp();
    const query = logAnalyticsQuery(hanging.credential, "hardhat-kms/0.0.0", {
      httpClient: {
        sendRequest: async (request) =>
          await new Promise((_resolve, reject) => {
            request.abortSignal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
            controller.abort(new Error("stop"));
          }),
      },
    });
    const key: AzureKmsKeyConfig = {
      provider: "azure",
      name: "deployer",
      displayId: "azure:deployer",
      timeoutMs: 30_000,
      keyId: { get: async () => await Promise.resolve(KEY_URL), display: KEY_URL },
    };
    const workspaceId = { get: async () => await Promise.resolve(WORKSPACE_ID), display: "w" };
    await assert.rejects(
      readAzureSignHistory(
        key,
        { azure: { workspaceId } },
        {
          key,
          since: new Date(RANGE.since),
          until: new Date(RANGE.until),
          limit: 10,
          signal: controller.signal,
        },
        query,
      ),
      /stop/,
    );
  });

  it("reads an answer with no body or a body that is not JSON as unreadable", async () => {
    endpoint.answers.push({ status: 200 });
    const { error } = await history();
    assert.ok(error instanceof Error);
    assert.match(error.message, /answered in a form this plugin does not read/);

    const raw = logAnalyticsHttp();
    const query = logAnalyticsQuery(raw.credential, "hardhat-kms/0.0.0", {
      httpClient: {
        sendRequest: async (request) =>
          await Promise.resolve({
            request,
            status: 200,
            headers: createHttpHeaders(),
            bodyAsText: "<html>",
          }),
      },
    });
    const answer = await query(
      WORKSPACE_ID,
      { query: "x", timespan: "P1D" },
      new AbortController().signal,
    );
    assert.deepEqual(answer, { status: 200, body: undefined });
  });
});
