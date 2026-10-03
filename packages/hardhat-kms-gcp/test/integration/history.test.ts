import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, beforeEach, describe, it, mock } from "node:test";

import type { KmsHistoryReport } from "hardhat-kms/types";
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsGcp from "../../src/index.ts";
import { CALL_TIMEOUT_MS } from "../../src/internal/history.ts";
import { kmsHandlers } from "../../src/internal/hook-handlers/kms.ts";
import { loggingTransport } from "../../src/internal/logging-client.ts";
import {
  FAILED_SIGN,
  IPV6_SIGN,
  KEY_RING,
  KEY_VERSION_NAME,
  PLUGIN_SIGN,
  PROJECT,
  SERVICE_ACCOUNT,
  SERVICE_ACCOUNT_SIGN,
} from "../fixtures/logging-entries.ts";
import { isolateGcpEnvironment } from "../helpers/kms-server.ts";
import {
  localAuth,
  localLogging,
  type LoggingServer,
  startLoggingServer,
} from "../helpers/logging-server.ts";

const ownVersion = String(
  Reflect.get(Object(createRequire(import.meta.url)("@hardhat-kms/gcp/package.json")), "version"),
);

// A range that holds the recorded entries, and is in the past.
const RANGE = { since: "2026-10-01T10:00:00Z", until: "2026-10-02T09:10:00Z" };

let server: LoggingServer;
let restoreEnvironment: () => void;

interface HistoryRun {
  report: KmsHistoryReport | undefined;
  error: unknown;
  stdout: string;
  stderr: string;
}

function isReport(value: unknown): value is KmsHistoryReport {
  return typeof value === "object" && value !== null && Reflect.get(value, "version") === 1;
}

/**
 * Runs `kms history` through the plugin, with its Cloud Logging call pointed at the local server.
 */
async function history(
  args: { key?: string; limit?: number; showIds?: boolean; json?: boolean } = {},
  version: string = ownVersion,
): Promise<HistoryRun> {
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKmsGcp],
    kms: {
      keys: {
        // From a variable, so that the key's display id names the variable, not the key.
        deployer: { provider: "gcp", keyVersionName: configVariable("HHKMS_HISTORY_GCP_KEY") },
        amazon: { provider: "aws", keyId: "alias/deployer", region: "eu-west-1" },
      },
    },
  });
  // Run-time handlers run first: the plugin's own handler, with Cloud Logging on the server.
  hre.hooks.registerHandlers("kms", kmsHandlers(version, undefined, localLogging(server.endpoint)));
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

function page(entries: unknown[], nextPageToken?: string) {
  return {
    status: 200,
    body: { entries, ...(nextPageToken === undefined ? {} : { nextPageToken }) },
  };
}

function apiError(status: number, name: string) {
  return {
    status,
    body: { error: { code: status, message: `on projects/${PROJECT}`, status: name } },
  };
}

describe("kms history on a Google Cloud key", () => {
  before(async () => {
    restoreEnvironment = isolateGcpEnvironment();
    process.env.HHKMS_HISTORY_GCP_KEY = KEY_VERSION_NAME;
    server = await startLoggingServer();
  });

  after(async () => {
    await server.close();
    restoreEnvironment();
  });

  beforeEach(() => {
    server.requests.length = 0;
    server.answers.length = 0;
  });

  it("reads the key's sign entries from Cloud Logging and shows them masked", async () => {
    server.answers.push(page([PLUGIN_SIGN, SERVICE_ACCOUNT_SIGN, FAILED_SIGN]));
    const { report, error, stdout, stderr } = await history();
    assert.equal(error, undefined);
    assert.ok(report);

    const [request] = server.requests;
    assert.equal(server.requests.length, 1);
    assert.equal(request?.path, "/v2/entries:list");
    assert.match(String(request?.headers.authorization), /^Bearer /);
    assert.ok(
      String(request?.headers["user-agent"]).startsWith(`hardhat-kms/${ownVersion} `),
      "the read carries the plugin's user agent",
    );
    assert.deepEqual(Reflect.get(Object(request?.body), "resourceNames"), [`projects/${PROJECT}`]);
    assert.match(
      String(Reflect.get(Object(request?.body), "filter")),
      /protoPayload\.methodName="AsymmetricSign" AND protoPayload\.resourceName:".*\/cryptoKeyVersions\/"/,
    );

    assert.equal(report.source, "cloud-logging");
    assert.deepEqual(report.notLogged, ["requestId"]);
    assert.deepEqual(
      report.events.map((event) => [event.outcome, event.keyVersion, event.digest?.slice(0, 6)]),
      [
        ["success", "1", "0xbbc5"],
        ["success", "2", "0xbbc5"],
        ["failed", "999999", "0xbbc5"],
      ],
    );
    // Without --show-ids, no project, key ring or key name reaches the output. Principals are
    // shown as logged, so a service account's email keeps its project.
    assert.match(stdout, new RegExp(`"principal": "${SERVICE_ACCOUNT}"`));
    // A subject that only repeats the email is left out; one that says more is kept.
    assert.doesNotMatch(stdout, /"principalSubject": "serviceAccount:/);
    assert.match(stdout, /"principalSubject": "principal:\/\/iam\.googleapis\.com\/placeholder"/);
    assert.match(stdout, /"scope": "project <hidden>, /);
    for (const text of [stdout.replaceAll(SERVICE_ACCOUNT, ""), stderr]) {
      assert.doesNotMatch(text, new RegExp(PROJECT));
      assert.doesNotMatch(text, new RegExp(KEY_RING));
    }
    assert.match(stdout, /"insertId": "insert-1"/);
    assert.match(stdout, /"userAgent": "hardhat-kms\/0\.0\.0 google-api-nodejs-client/);
  });

  it("shows the ids with --show-ids", async () => {
    server.answers.push(page([PLUGIN_SIGN]));
    const { report, stdout } = await history({ showIds: true });
    assert.equal(report?.events[0]?.keyResource, KEY_VERSION_NAME);
    assert.match(stdout, new RegExp(PROJECT));
  });

  it("prints the table, with the key version and the digest", async () => {
    server.answers.push(page([PLUGIN_SIGN]));
    const { stdout } = await history({ json: false });
    assert.match(stdout, /from cloud-logging/);
    assert.match(stdout, /AsymmetricSign/);
    assert.match(stdout, /0xbbc5f4ce/);
    assert.doesNotMatch(stdout, new RegExp(PROJECT));
  });

  it("shows an IPv6 caller address as logged, in the table and the JSON, without --show-ids", async () => {
    const ip = "2001:db8:85a3::8a2e:370:7334";
    server.answers.push(page([IPV6_SIGN]));
    const json = await history();
    assert.equal(json.report?.events[0]?.sourceIp, ip);
    assert.match(json.stdout, new RegExp(`"sourceIp": "${ip}"`));
    server.answers.push(page([IPV6_SIGN]));
    const table = await history({ json: false });
    assert.ok(table.stdout.includes(ip), "the table does not show the address");
  });

  it("follows page tokens over HTTP", async () => {
    server.answers.push(page([PLUGIN_SIGN], "page-2"), page([SERVICE_ACCOUNT_SIGN]));
    const { report } = await history();
    assert.equal(server.requests.length, 2);
    assert.equal(Reflect.get(Object(server.requests[1]?.body), "pageToken"), "page-2");
    assert.equal(report?.events.length, 2);
  });

  it("says an empty history proves little, and how to turn the logs on", async () => {
    server.answers.push(page([]));
    const { report, stderr } = await history();
    assert.deepEqual(report?.events, []);
    assert.match(stderr, /The log returned no sign events in this range/);
    assert.match(stderr, /Data Access audit logs \(DATA_READ\)/);
  });

  it("fails with the permission to grant when Cloud Logging refuses the read", async () => {
    server.answers.push(apiError(403, "PERMISSION_DENIED"));
    const { error, stdout } = await history();
    assert.ok(error instanceof Error);
    assert.match(
      error.message,
      /lack logging\.privateLogEntries\.list \(roles\/logging\.privateLogViewer\)/,
    );
    assert.doesNotMatch(error.message, new RegExp(PROJECT));
    assert.equal(stdout, "");
  });

  it("gives the status of another error answer, never the server's message", async () => {
    server.answers.push(apiError(400, "INVALID_ARGUMENT"));
    const { error } = await history();
    assert.ok(error instanceof Error);
    assert.match(
      error.message,
      /reading the Cloud Logging entries failed \(400 INVALID_ARGUMENT\)/,
    );
    assert.doesNotMatch(error.message, new RegExp(PROJECT));
  });

  it("passes keys of other providers on", async () => {
    const { error } = await history({ key: "amazon" });
    assert.ok(error instanceof Error);
    assert.match(error.message, /hardhat-kms-aws/);
    assert.equal(server.requests.length, 0);
  });

  it("checks the core's version before reading", async () => {
    const { error } = await history({}, "9.9.9");
    assert.ok(error instanceof Error);
    assert.match(error.message, /needs hardhat-kms 9\.9\.9/);
    assert.equal(server.requests.length, 0);
  });

  it("builds the real Cloud Logging call only when a Google Cloud key's history is read", async () => {
    // The plugin's own handler, with google-auth-library's Application Default Credentials. The
    // signal has aborted, so the reader stops before its first call and nothing is sent.
    const hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKmsGcp],
      kms: { keys: { deployer: { provider: "gcp", keyVersionName: KEY_VERSION_NAME } } },
    });
    const key = hre.config.kms.keys.deployer;
    assert.ok(key);
    const controller = new AbortController();
    controller.abort(new Error("stopped before the first call"));
    await assert.rejects(
      hre.hooks.runHandlerChain(
        "kms",
        "readSignHistory",
        [
          {
            key,
            since: new Date(RANGE.since),
            until: new Date(RANGE.until),
            limit: 1,
            signal: controller.signal,
          },
        ],
        async () => await Promise.reject(new Error("unclaimed")),
      ),
      /stopped before the first call/,
    );
  });

  describe("the HTTP call", () => {
    const body = {
      resourceNames: [`projects/${PROJECT}`],
      filter: "x",
      orderBy: "timestamp desc" as const,
      pageSize: 1,
    };

    it("rejects at once when the signal has aborted", async () => {
      const list = await localLogging(server.endpoint)("hardhat-kms/test");
      const controller = new AbortController();
      controller.abort(new Error("deadline"));
      await assert.rejects(list(body, controller.signal, CALL_TIMEOUT_MS), /deadline/);
      assert.equal(server.requests.length, 0);
    });

    it("rejects, and does not crash the process, when the signal aborts before the body is sent", async () => {
      // As an abort during a token refresh: the signal has aborted when gaxios hands the request
      // to node-fetch, which then destroys the request body with the abort error.
      const auth = localAuth();
      const controller = new AbortController();
      const list = loggingTransport(
        {
          request: async (options) => {
            controller.abort();
            return await auth.request(options);
          },
        },
        "hardhat-kms/test",
        server.endpoint,
      );
      await assert.rejects(list(body, controller.signal, CALL_TIMEOUT_MS));
      // Give an unhandled 'error' event the chance to surface and fail the run.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(server.requests.length, 0);
    });

    it("gives up on a call with no answer after its time", async () => {
      server.answers.push("hang");
      const list = loggingTransport(localAuth(), "hardhat-kms/test", server.endpoint);
      await assert.rejects(list(body, new AbortController().signal, 100), {
        name: "CallTimedOut",
      });
    });

    it("rejects when the signal aborts while the server has not answered", async () => {
      server.answers.push("hang");
      const list = await localLogging(server.endpoint)("hardhat-kms/test");
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort();
      }, 100);
      await assert.rejects(list(body, controller.signal, CALL_TIMEOUT_MS));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    it("sends the request as JSON and returns the parsed answer", async () => {
      server.answers.push(page([PLUGIN_SIGN]));
      const list = await localLogging(server.endpoint)("hardhat-kms/test");
      const answer = await list(body, new AbortController().signal, CALL_TIMEOUT_MS);
      assert.deepEqual(server.requests.at(-1)?.body, body);
      assert.equal(server.requests.at(-1)?.headers["content-type"], "application/json");
      assert.deepEqual(answer, { entries: [PLUGIN_SIGN] });
    });

    it("uses Cloud Logging's endpoint by default", async () => {
      const urls: unknown[] = [];
      const list = loggingTransport(
        {
          request: async (options) => {
            urls.push(options.url);
            return await Promise.reject(new Error("offline"));
          },
        },
        "hardhat-kms/test",
      );
      await assert.rejects(list(body, new AbortController().signal, CALL_TIMEOUT_MS), /offline/);
      assert.deepEqual(urls, ["https://logging.googleapis.com/v2/entries:list"]);
    });
  });
});
