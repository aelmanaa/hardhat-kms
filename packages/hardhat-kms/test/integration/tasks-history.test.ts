import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { HardhatError } from "@nomicfoundation/hardhat-errors";
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { HardhatPluginError } from "hardhat/plugins";
import type { HardhatUserConfig } from "hardhat/types/config";

import hardhatKms from "../../src/index.ts";
import { HISTORY_DEADLINE_MS, readSignHistory } from "../../src/internal/history/read.ts";
import { auditLogAccessDenied, auditLogThrottled } from "../../src/provider-utils.ts";
import type {
  KmsHistoryReport,
  KmsHistoryRequest,
  KmsHooks,
  KmsKeyUserConfig,
} from "../../src/types.ts";
import {
  fakeHistoryReader,
  historyEvent,
  historyResult,
  PLACEHOLDERS,
} from "../helpers/fake-history-reader.ts";
import { fakeTimers } from "../helpers/fake-timers.ts";
import { vaultKey } from "../helpers/vault-key.ts";

const HOUR = 60 * 60 * 1000;
// A configuration variable's value, a valid key ARN in an account no other fixture uses: the
// plugin must never print it without --show-ids.
const SECRET_KEY_ID = "arn:aws:kms:eu-west-1:999988887777:key/5ec2e7aa-1111-4222-8333-944455556666";
const SECRET = /999988887777/;

const VARIABLES = [
  "AWS_KMS_KEY_ID",
  "HHKMS_HISTORY_KEY_ID",
  "HHKMS_HISTORY_WORKSPACE",
  "HHKMS_HISTORY_PROJECT",
  "HHKMS_HISTORY_AZURE_KEY",
];
const saved = new Map(VARIABLES.map((name) => [name, process.env[name]]));
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  }
});

/** A runtime with a `myvault` key, an AWS key from a configuration variable, and the readers. */
async function runtime(
  options: {
    readers?: Array<Partial<KmsHooks>>;
    keys?: Record<string, KmsKeyUserConfig>;
    kms?: string;
  } = {},
) {
  process.env.HHKMS_HISTORY_KEY_ID = SECRET_KEY_ID;
  const hre = await createHardhatRuntimeEnvironment(
    {
      plugins: [hardhatKms],
      kms: {
        keys: options.keys ?? {
          deployer: vaultKey("deployer"),
          treasury: { provider: "aws", keyId: configVariable("HHKMS_HISTORY_KEY_ID") },
        },
      },
    },
    options.kms === undefined ? {} : { kms: options.kms },
  );
  for (const handlers of options.readers ?? []) {
    hre.hooks.registerHandlers("kms", handlers);
  }
  return hre;
}

interface HistoryArgs {
  key: string;
  since?: string;
  until?: string;
  limit?: number;
  json?: boolean;
  showIds?: boolean;
}

interface HistoryRun {
  report: KmsHistoryReport | undefined;
  error: unknown;
  stdout: string;
  stderr: string;
}

function isReport(value: unknown): value is KmsHistoryReport {
  return typeof value === "object" && value !== null && Reflect.get(value, "version") === 1;
}

/** Runs `kms history` and returns its report or error and what it printed on each stream. */
async function history(
  hre: Awaited<ReturnType<typeof runtime>>,
  args: HistoryArgs,
): Promise<HistoryRun> {
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
      key: args.key,
      since: args.since,
      until: args.until,
      limit: args.limit ?? 100,
      json: args.json ?? false,
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

/** A settled range: a day that ended a day ago. */
const SECOND = 1000;
const wholeSecond = (time: number) => new Date(Math.floor(time / SECOND) * SECOND).toISOString();
const SETTLED = {
  since: wholeSecond(Date.now() - 2 * 24 * HOUR),
  until: wholeSecond(Date.now() - 24 * HOUR),
};

/** A result whose one event lies inside the request's range. */
function answerIn(request: KmsHistoryRequest, overrides = {}) {
  return historyResult({
    events: [historyEvent({ time: request.until.toISOString(), ...overrides })],
  });
}

function assertPluginError(error: unknown, message: string | RegExp): void {
  assert.ok(error instanceof HardhatPluginError, `expected a plugin error, got ${String(error)}`);
  if (typeof message === "string") {
    assert.equal(error.message, message);
  } else {
    assert.match(error.message, message);
  }
}

describe("kms history", () => {
  it("is a subtask of kms", async () => {
    const hre = await runtime();

    assert.ok(hre.tasks.getTask("kms").subtasks.has("history"));
  });

  it("asks the reader for the last 24 hours and 100 events by default", async () => {
    const reader = fakeHistoryReader("myvault", (request) => answerIn(request));
    const hre = await runtime({ readers: [reader.handlers] });
    const before = Date.now();

    const run = await history(hre, { key: "deployer" });

    assert.equal(run.error, undefined);
    const [request] = reader.requests;
    assert.ok(request !== undefined);
    assert.equal(request.key.name, "deployer");
    assert.equal(request.limit, 100);
    // Whole seconds: the start rounded down, the end up.
    assert.equal(request.since.getMilliseconds(), 0);
    assert.equal(request.until.getMilliseconds(), 0);
    assert.ok(request.until.getTime() >= before && request.until.getTime() <= Date.now() + SECOND);
    const span = request.until.getTime() - request.since.getTime();
    assert.ok(span >= 24 * HOUR && span <= 24 * HOUR + SECOND);
  });

  it("passes the range and the limit as given", async () => {
    const reader = fakeHistoryReader("myvault", () => historyResult({ events: [] }));
    const hre = await runtime({ readers: [reader.handlers] });

    await history(hre, {
      key: "deployer",
      since: "2026-09-01",
      until: "2026-09-02T12:00:00+02:00",
      limit: 7,
    });

    assert.equal(reader.requests[0]?.since.toISOString(), "2026-09-01T00:00:00.000Z");
    assert.equal(reader.requests[0]?.until.toISOString(), "2026-09-02T10:00:00.000Z");
    assert.equal(reader.requests[0]?.limit, 7);
  });

  it("checks the range and the limit before it reads anything", async () => {
    const reader = fakeHistoryReader("myvault", () => historyResult());
    const hre = await runtime({ readers: [reader.handlers] });

    for (const [args, message] of [
      [{ since: "yesterday" }, /--since "yesterday" is not a time/],
      [{ since: "1h", until: "2h" }, /must be before --until/],
      [{ limit: 0 }, /--limit must be an integer from 1 to 1000, got 0/],
      [{ limit: 1001 }, /got 1001/],
    ] as const) {
      const run = await history(hre, { key: "deployer", ...args });
      assertPluginError(run.error, message);
    }
    assert.equal(reader.requests.length, 0);
  });

  it("resolves the key as other tasks do, including --kms names, and lists the known keys when it is unknown", async () => {
    process.env.AWS_KMS_KEY_ID = "alias/from-env";
    const reader = fakeHistoryReader("aws", (request) => answerIn(request));
    const hre = await runtime({ readers: [reader.handlers], kms: "aws" });

    const run = await history(hre, { key: "AWS_KMS_KEY_ID", ...SETTLED });
    assert.equal(run.error, undefined);
    assert.equal(reader.requests[0]?.key.name, "AWS_KMS_KEY_ID");
    assert.equal(run.report?.key.displayId, "aws:<AWS_KMS_KEY_ID>");

    const unknown = await history(hre, { key: "nope" });
    assertPluginError(
      unknown.error,
      /unknown key "nope"\. Known keys: deployer, treasury, AWS_KMS_KEY_ID\./,
    );
  });

  it("fails and names the provider when no plugin reads a third-party provider's log", async () => {
    const hre = await runtime();

    const run = await history(hre, { key: "deployer" });

    assertPluginError(
      run.error,
      'myvault, history, key myvault:deployer: no plugin reads the audit log of "myvault" keys, so kms history cannot list this key\'s sign events',
    );
    assert.equal(run.stdout, "");
  });

  it("fails and names the provider package for a built-in provider without a reader", async () => {
    const hre = await runtime();

    const run = await history(hre, { key: "treasury" });

    assertPluginError(
      run.error,
      "aws, history, key aws:<HHKMS_HISTORY_KEY_ID>: no installed plugin reads AWS KMS audit logs. The reader ships in @hardhat-kms/aws; install or update it to the same version as hardhat-kms, and add it to `plugins` in your Hardhat config",
    );
  });

  it("passes keys along the chain: each reader reads only its own provider", async () => {
    const aws = fakeHistoryReader("aws", (request) => answerIn(request, { requestId: "from-aws" }));
    const vault = fakeHistoryReader("myvault", (request) =>
      answerIn(request, { requestId: "from-vault" }),
    );
    const hre = await runtime({ readers: [aws.handlers, vault.handlers] });

    const run = await history(hre, { key: "deployer", ...SETTLED });

    assert.equal(run.report?.events[0]?.requestId, "from-vault");
    assert.equal(aws.requests.length, 0);
    assert.equal(vault.requests.length, 1);
  });

  it("fails and names the missing permission when the reader is refused, printing nothing on standard output", async () => {
    const reader = fakeHistoryReader("aws", (request) => {
      throw auditLogAccessDenied("cloudtrail:LookupEvents", {
        provider: "aws",
        operation: "history",
        key: request.key.displayId,
      });
    });
    const hre = await runtime({ readers: [reader.handlers] });

    const run = await history(hre, { key: "treasury", json: true });

    assertPluginError(
      run.error,
      "aws, history, key aws:<HHKMS_HISTORY_KEY_ID>: cannot read the audit log: the credentials lack cloudtrail:LookupEvents. Grant it, or run with credentials that have it",
    );
    assert.equal(run.stdout, "");
  });

  it("fails with a clear error when the log keeps throttling", async () => {
    const reader = fakeHistoryReader("myvault", () => {
      throw auditLogThrottled("2 lookups per second");
    });
    const hre = await runtime({ readers: [reader.handlers] });

    const run = await history(hre, { key: "deployer" });

    assertPluginError(
      run.error,
      "the audit log kept refusing requests as too frequent (2 lookups per second)",
    );
  });

  it("keeps only the class name of a reader's own error, whose text could carry request details", async () => {
    class LookupFailure extends Error {
      override name = "LookupFailure";
    }
    const reader = fakeHistoryReader("aws", () => {
      throw new LookupFailure(`request for ${SECRET_KEY_ID} failed`);
    });
    const hre = await runtime({ readers: [reader.handlers] });

    const run = await history(hre, { key: "treasury" });

    assertPluginError(
      run.error,
      "aws, history, key aws:<HHKMS_HISTORY_KEY_ID>: reading the audit log failed (LookupFailure)",
    );
    assert.doesNotMatch(`${String(run.error)}${run.stdout}${run.stderr}`, SECRET);
  });

  it("refuses a result that breaks the contract, naming the problem", async () => {
    const reader = fakeHistoryReader("myvault", () =>
      historyResult({ events: [historyEvent({ time: "2001-01-01T00:00:00Z", keyVersion: "1" })] }),
    );
    const hre = await runtime({ readers: [reader.handlers] });

    const run = await history(hre, { key: "deployer" });

    assertPluginError(
      run.error,
      "myvault, history, key myvault:deployer: the history reader returned an invalid result: events[0].time is outside the requested range; events[0].keyVersion has a value, but the reader lists it as not logged",
    );
    const nothing = await history(
      await runtime({ readers: [fakeHistoryReader("myvault", () => undefined).handlers] }),
      { key: "deployer" },
    );
    assertPluginError(nothing.error, /invalid result: the result must be an object$/);
  });

  it("prints the version 1 JSON report, with ids masked and only the error code", async () => {
    const reader = fakeHistoryReader("aws", (request) =>
      historyResult({
        events: [
          historyEvent({ time: request.until.toISOString() }),
          historyEvent({
            time: request.since.toISOString(),
            outcome: "failed",
            errorCode: "AccessDeniedException",
            errorMessage: PLACEHOLDERS.errorMessage,
            // A reader that leaks the configured key id into a free field is still masked.
            extra: { requestKeyId: SECRET_KEY_ID },
          }),
        ],
      }),
    );
    const hre = await runtime({ readers: [reader.handlers] });

    const run = await history(hre, { key: "treasury", json: true, ...SETTLED });

    assert.equal(run.error, undefined);
    const printed: unknown = JSON.parse(run.stdout);
    assert.deepEqual(printed, run.report);
    assert.deepEqual(run.report, {
      version: 1,
      key: { name: "treasury", provider: "aws", displayId: "aws:<HHKMS_HISTORY_KEY_ID>" },
      source: "fake-audit-log",
      range: { since: SETTLED.since, until: SETTLED.until },
      scope: null,
      notLogged: ["keyVersion", "digest"],
      events: [
        {
          time: SETTLED.until,
          operation: "Sign",
          outcome: "success",
          error: null,
          principal: "arn:aws:iam::111122223333:role/deployer",
          sourceIp: "203.0.113.7",
          userAgent: "aws-sdk-js/3.0.0 hardhat-kms/0.0.0",
          requestId: "11111111-2222-3333-4444-555555555555",
          keyVersion: null,
          digest: null,
          keyResource: "aws:<HHKMS_HISTORY_KEY_ID>",
          extra: { readOnly: true },
        },
        {
          time: SETTLED.since,
          operation: "Sign",
          outcome: "failed",
          error: { code: "AccessDeniedException", message: null },
          principal: "arn:aws:iam::111122223333:role/deployer",
          sourceIp: "203.0.113.7",
          userAgent: "aws-sdk-js/3.0.0 hardhat-kms/0.0.0",
          requestId: "11111111-2222-3333-4444-555555555555",
          keyVersion: null,
          digest: null,
          keyResource: "aws:<HHKMS_HISTORY_KEY_ID>",
          extra: { requestKeyId: "aws:<HHKMS_HISTORY_KEY_ID>" },
        },
      ],
      truncated: false,
      truncatedReason: null,
      notes: [],
    });
    assert.doesNotMatch(
      `${run.stdout}${run.stderr}`,
      /PLACEHOLDER|999988887777|AKIA/,
      "no key id, access key id, error message or variable value by default",
    );
  });

  it("shows ids, error messages and the variable's value with --show-ids, after a warning", async () => {
    const reader = fakeHistoryReader("aws", (request) =>
      answerIn(request, {
        outcome: "failed",
        errorCode: "AccessDeniedException",
        errorMessage: PLACEHOLDERS.errorMessage,
        extra: { requestKeyId: SECRET_KEY_ID },
      }),
    );
    const hre = await runtime({ readers: [reader.handlers] });

    const run = await history(hre, { key: "treasury", ...SETTLED, showIds: true });

    assert.match(
      run.stderr,
      /--show-ids prints key ids, provider id fields and error messages in full/,
    );
    assert.ok(run.stdout.includes(`key: ${PLACEHOLDERS.keyArn}`));
    assert.ok(run.stdout.includes(`error: ${PLACEHOLDERS.errorMessage}`));
    assert.ok(run.stdout.includes(`accessKeyId: ${PLACEHOLDERS.accessKeyId}`));
    assert.ok(run.stdout.includes(`requestKeyId: ${SECRET_KEY_ID}`));
  });

  it("prints a table by default, with principal, IP and user agent, and masked ids", async () => {
    const reader = fakeHistoryReader("aws", (request) => answerIn(request));
    const hre = await runtime({ readers: [reader.handlers] });

    const run = await history(hre, { key: "treasury", ...SETTLED });

    const lines = run.stdout.split("\n");
    assert.equal(
      lines[0],
      "Sign events of treasury (aws:<HHKMS_HISTORY_KEY_ID>), from fake-audit-log",
    );
    assert.equal(lines[2], "Not logged by this provider: key version, digest");
    assert.match(lines[4] ?? "", /^TIME +OPERATION +OUTCOME +PRINCIPAL +SOURCE IP$/);
    assert.match(
      lines[5] ?? "",
      / success +arn:aws:iam::111122223333:role\/deployer +203\.0\.113\.7$/,
    );
    assert.equal(lines[6], "  user agent (client-reported): aws-sdk-js/3.0.0 hardhat-kms/0.0.0");
    assert.doesNotMatch(run.stdout, /PLACEHOLDER|999988887777|AKIA/);
    assert.equal(run.stderr, "");
  });

  it("shows a literal key id as the display id, and hides nothing for a variable it cannot read", async () => {
    const gcpName = "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1";
    const reader = fakeHistoryReader("gcp", (request) =>
      answerIn(request, { principal: `caller of ${gcpName}` }),
    );
    const unreadable = fakeHistoryReader("aws", (request) =>
      answerIn(request, { principal: "caller of not-a-key-id" }),
    );
    process.env.HHKMS_HISTORY_KEY_ID = "not-a-key-id";
    const hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKms],
      kms: {
        keys: {
          literal: { provider: "gcp", keyVersionName: gcpName },
          broken: { provider: "aws", keyId: configVariable("HHKMS_HISTORY_KEY_ID") },
        },
      },
    });
    hre.hooks.registerHandlers("kms", reader.handlers);
    hre.hooks.registerHandlers("kms", unreadable.handlers);

    const literal = await history(hre, { key: "literal", ...SETTLED, json: true });
    const broken = await history(hre, { key: "broken", ...SETTLED, json: true });

    // The literal id is in the config and in the display id already, which masking never rewrites.
    assert.equal(literal.report?.events[0]?.principal, `caller of gcp:${gcpName}`);
    // A real reader fails on an invalid id first; the report has no value to hide.
    assert.equal(broken.report?.events[0]?.principal, "caller of not-a-key-id");
  });

  it("says an empty result does not confirm logging, and never that there were no signatures", async () => {
    const reader = fakeHistoryReader("myvault", () =>
      historyResult({
        events: [],
        completeForKey: false,
        setupHint: "Check that Data Access logs are on for Cloud KMS.",
      }),
    );
    const hre = await runtime({ readers: [reader.handlers] });

    const json = await history(hre, { key: "deployer", ...SETTLED, json: true });
    const table = await history(hre, { key: "deployer", ...SETTLED });

    assert.deepEqual(json.report?.events, []);
    assert.deepEqual(
      json.report?.notes.map((note) => note.code),
      ["logging-not-confirmed"],
    );
    assert.match(
      json.stderr,
      /\[hardhat-kms\] The log returned no sign events in this range\. That does not show that the key signed nothing: .* Check that Data Access logs are on for Cloud KMS\./,
    );
    assert.match(table.stdout, /No sign events in fake-audit-log for this range\./);
    assert.doesNotMatch(
      `${json.stdout}${json.stderr}${table.stdout}${table.stderr}`,
      /no signatures/i,
    );
  });

  it("notes that recent events may be missing when the range ends within 15 minutes", async () => {
    const reader = fakeHistoryReader("aws", () => historyResult({ events: [] }));
    const hre = await runtime({ readers: [reader.handlers] });

    const recent = await history(hre, { key: "treasury", json: true });
    const settled = await history(hre, { key: "treasury", until: "16m", json: true });

    assert.deepEqual(
      recent.report?.notes.map((note) => note.code),
      ["recent-events-may-be-missing"],
    );
    assert.match(
      recent.stderr,
      /Events from the last 15 minutes may not be in the log yet: the provider documents a delivery delay of about 5 minutes for fake-audit-log\./,
    );
    assert.deepEqual(settled.report?.notes, []);
  });

  it("notes that the log holds nothing before its retention when --since is older", async () => {
    const reader = fakeHistoryReader("aws", () => historyResult({ events: [] }));
    const hre = await runtime({ readers: [reader.handlers] });

    const old = await history(hre, { key: "treasury", since: "91d", until: "1d", json: true });
    const inside = await history(hre, { key: "treasury", since: "89d", until: "1d", json: true });

    assert.deepEqual(
      old.report?.notes.map((note) => note.code),
      ["before-retention"],
    );
    assert.match(old.stderr, /The log keeps 90 days of events, so it holds none from before /);
    assert.deepEqual(inside.report?.notes, []);
  });

  it("prints the reader's own notes after the plugin's", async () => {
    const reader = fakeHistoryReader("myvault", () =>
      historyResult({
        events: [],
        notes: [{ code: "other-account", message: "These credentials see only one account." }],
      }),
    );
    const hre = await runtime({ readers: [reader.handlers] });

    const run = await history(hre, { key: "deployer", json: true });

    assert.deepEqual(
      run.report?.notes.map((note) => note.code),
      ["recent-events-may-be-missing", "other-account"],
    );
    assert.match(run.stderr, /These credentials see only one account\./);
  });

  it("reads an event at the start of a range given with milliseconds, since the range is read on whole seconds", async () => {
    const reader = fakeHistoryReader("myvault", () =>
      historyResult({ events: [historyEvent({ time: "2026-09-01T10:00:00Z" })] }),
    );
    const hre = await runtime({ readers: [reader.handlers] });

    const run = await history(hre, {
      key: "deployer",
      since: "2026-09-01T10:00:00.250Z",
      until: "2026-09-01T11:00:00Z",
      json: true,
    });

    assert.equal(run.error, undefined);
    assert.deepEqual(run.report?.range, {
      since: "2026-09-01T10:00:00.000Z",
      until: "2026-09-01T11:00:00.000Z",
    });
    assert.equal(run.report?.events[0]?.time, "2026-09-01T10:00:00.000Z");
  });

  it("masks the Azure workspace id from a variable as <hidden>, in a reader error and in its notes", async () => {
    const workspace = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const keyUrl = "https://secret-vault.vault.azure.net/keys/deployer";
    process.env.HHKMS_HISTORY_WORKSPACE = workspace;
    process.env.HHKMS_HISTORY_AZURE_KEY = keyUrl;
    const config: HardhatUserConfig = {
      plugins: [hardhatKms],
      kms: {
        keys: { vault: { provider: "azure", keyId: configVariable("HHKMS_HISTORY_AZURE_KEY") } },
        audit: { azure: { workspaceId: configVariable("HHKMS_HISTORY_WORKSPACE") } },
      },
    };
    const throwing = await createHardhatRuntimeEnvironment(config);
    throwing.hooks.registerHandlers(
      "kms",
      fakeHistoryReader("azure", () => {
        throw new HardhatPluginError(
          "a-reader",
          `cannot read ${keyUrl.toUpperCase()} in workspace ${workspace} of vault secret-vault`,
        );
      }).handlers,
    );
    const noting = await createHardhatRuntimeEnvironment(config);
    noting.hooks.registerHandlers(
      "kms",
      fakeHistoryReader("azure", () =>
        historyResult({
          events: [],
          notes: [{ code: "workspace", message: `read workspace ${workspace.toUpperCase()}` }],
        }),
      ).handlers,
    );

    const thrown = await history(throwing, { key: "vault" });
    const noted = await history(noting, { key: "vault", ...SETTLED, json: true });

    // The key value prints as the key; the workspace and the vault name are not the key.
    assertPluginError(
      thrown.error,
      "cannot read azure:<HHKMS_HISTORY_AZURE_KEY> in workspace <hidden> of vault <hidden>",
    );
    assert.equal(noted.report?.notes[0]?.message, "read workspace <hidden>");
    assert.doesNotMatch(`${noted.stdout}${noted.stderr}`, /0f8fad5b|secret-vault/i);
  });

  it("reads the workspace variable only for Azure keys, so other keys never prompt for it", async () => {
    const fetched: string[] = [];
    const hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKms],
      kms: {
        keys: {
          treasury: { provider: "aws", keyId: configVariable("HHKMS_HISTORY_KEY_ID") },
          vault: { provider: "azure", keyId: "https://secret-vault.vault.azure.net/keys/deployer" },
        },
        audit: { azure: { workspaceId: configVariable("HHKMS_HISTORY_WORKSPACE") } },
      },
    });
    // A keystore: Hardhat asks it for a variable only when the environment does not set it.
    const keystore: Record<string, string> = {
      HHKMS_HISTORY_KEY_ID: SECRET_KEY_ID,
      HHKMS_HISTORY_WORKSPACE: "0f8fad5b-d9cb-469f-a165-70867728950e",
    };
    hre.hooks.registerHandlers("configurationVariables", {
      fetchValue: async (context, variable, next) => {
        fetched.push(variable.name);
        return keystore[variable.name] ?? (await next(context, variable));
      },
    });
    Reflect.deleteProperty(process.env, "HHKMS_HISTORY_KEY_ID");
    Reflect.deleteProperty(process.env, "HHKMS_HISTORY_WORKSPACE");
    for (const provider of ["aws", "azure"]) {
      hre.hooks.registerHandlers(
        "kms",
        fakeHistoryReader(provider, (request) => answerIn(request)).handlers,
      );
    }

    await history(hre, { key: "treasury", ...SETTLED });
    assert.deepEqual(fetched, ["HHKMS_HISTORY_KEY_ID"]);
    await history(hre, { key: "vault", ...SETTLED });
    assert.deepEqual(fetched, ["HHKMS_HISTORY_KEY_ID", "HHKMS_HISTORY_WORKSPACE"]);
  });

  it("leaves a workspace variable it cannot read to the reader", async () => {
    Reflect.deleteProperty(process.env, "HHKMS_HISTORY_WORKSPACE");
    const reader = fakeHistoryReader("azure", (request) => answerIn(request));
    const hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKms],
      kms: {
        keys: {
          vault: { provider: "azure", keyId: "https://secret-vault.vault.azure.net/keys/a" },
        },
        audit: { azure: { workspaceId: configVariable("HHKMS_HISTORY_WORKSPACE") } },
      },
    });
    hre.hooks.registerHandlers("kms", reader.handlers);

    const run = await history(hre, { key: "vault", ...SETTLED });

    assert.equal(run.error, undefined);
    assert.equal(reader.requests.length, 1);
  });

  it("masks the value of a variable part of a Google Cloud key as <hidden>, and the joined key as the key", async () => {
    process.env.HHKMS_HISTORY_PROJECT = "secret-project-42";
    const name =
      "projects/secret-project-42/locations/global/keyRings/ring/cryptoKeys/deployer/cryptoKeyVersions/1";
    const hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKms],
      kms: {
        keys: {
          joined: {
            provider: "gcp",
            projectId: configVariable("HHKMS_HISTORY_PROJECT"),
            location: "global",
            keyRing: "ring",
            keyName: "deployer",
            keyVersion: 1,
          },
        },
      },
    });
    hre.hooks.registerHandlers(
      "kms",
      fakeHistoryReader("gcp", (request) =>
        answerIn(request, {
          principal: "signer@secret-project-42.iam.gserviceaccount.com",
          keyResource: name,
          extra: { project: "secret-project-42", resource: name },
        }),
      ).handlers,
    );

    const run = await history(hre, { key: "joined", ...SETTLED, json: true });

    const displayId =
      "gcp:projects/<HHKMS_HISTORY_PROJECT>/locations/global/keyRings/ring/cryptoKeys/deployer/cryptoKeyVersions/1";
    assert.equal(run.report?.key.displayId, displayId);
    assert.deepEqual(run.report?.events[0]?.extra, {
      project: "<hidden>",
      resource: displayId,
    });
    // A hidden project is masked inside a principal's email too.
    assert.equal(run.report?.events[0]?.principal, "signer@<hidden>.iam.gserviceaccount.com");
    assert.doesNotMatch(run.stdout, /secret-project-42/);
  });

  it("throws a new error with the masked text of a reader's Hardhat error and no cause", async () => {
    const reader = fakeHistoryReader("aws", () => {
      throw new HardhatError(HardhatError.ERRORS.CORE.INTERNAL.ASSERTION_ERROR, {
        message: `lookup of ${SECRET_KEY_ID} failed`,
      });
    });
    const hre = await runtime({ readers: [reader.handlers] });

    const run = await history(hre, { key: "treasury" });

    assertPluginError(
      run.error,
      /^An internal invariant was violated: lookup of aws:<HHKMS_HISTORY_KEY_ID> failed$/,
    );
    assert.ok(!HardhatError.isHardhatError(run.error));
    assert.equal(run.error instanceof Error ? run.error.cause : "not an error", undefined);
    assert.doesNotMatch(String(run.error instanceof Error ? run.error.stack : ""), SECRET);
  });

  it("drops the cause of a reader's plugin error, which masking cannot reach", async () => {
    const reader = fakeHistoryReader("aws", () => {
      throw new HardhatPluginError("a-reader", "lookup failed", new Error(`for ${SECRET_KEY_ID}`));
    });
    const hre = await runtime({ readers: [reader.handlers] });

    const run = await history(hre, { key: "treasury" });

    assertPluginError(run.error, "lookup failed");
    assert.equal(run.error instanceof Error ? run.error.cause : "not an error", undefined);
  });

  it("masks ids a reader's error holds that the plugin was never given, such as the ARN of a literal alias", async () => {
    const resolved = "arn:aws:kms:eu-west-1:444455556666:key/0a1b2c3d-1111-4222-8333-944455556666";
    const reader = fakeHistoryReader("aws", () => {
      throw new HardhatPluginError("a-reader", `no events for ${resolved}`);
    });
    const hre = await runtime({
      readers: [reader.handlers],
      keys: { literal: { provider: "aws", keyId: "alias/deployer", region: "eu-west-1" } },
    });

    const run = await history(hre, { key: "literal" });

    assertPluginError(run.error, "no events for <hidden>");
  });

  it("passes the reader a signal that aborts at the deadline, and fails then even if the reader ignores it", async () => {
    const signals: AbortSignal[] = [];
    const hre = await runtime({
      readers: [
        fakeHistoryReader("myvault", async (request) => {
          if (request.signal !== undefined) {
            signals.push(request.signal);
          }
          // Never answers.
          return await new Promise(() => {});
        }).handlers,
      ],
    });
    const timers = fakeTimers();
    const key = hre.config.kms.keys.deployer;
    assert.ok(key !== undefined);

    const read = readSignHistory(
      hre,
      {
        key,
        since: new Date(Date.parse(SETTLED.since)),
        until: new Date(Date.parse(SETTLED.until)),
        limit: 1,
      },
      (text) => text,
      timers,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(timers.delays(), [HISTORY_DEADLINE_MS]);
    assert.equal(HISTORY_DEADLINE_MS, 120_000);
    assert.equal(signals[0]?.aborted, false);
    timers.fire();

    await assert.rejects(read, (error: unknown) => {
      assertPluginError(
        error,
        "myvault, history, key myvault:deployer: reading the audit log took more than 120 seconds, so kms history stopped waiting",
      );
      return true;
    });
    assert.equal(signals[0]?.aborted, true);
  });

  it("refuses a limit reason with fewer than limit events, and says when an early stop found nothing", async () => {
    const refused = await history(
      await runtime({
        readers: [
          fakeHistoryReader("myvault", () =>
            historyResult({ events: [], truncated: true, truncatedReason: "limit" }),
          ).handlers,
        ],
      }),
      { key: "deployer", ...SETTLED },
    );
    assertPluginError(
      refused.error,
      /invalid result: truncatedReason is "limit", but the result holds fewer than limit events$/,
    );

    const hre = await runtime({
      readers: [
        fakeHistoryReader("myvault", () =>
          historyResult({
            events: [],
            truncated: true,
            truncatedReason: "scan-limit",
            completeForKey: false,
          }),
        ).handlers,
      ],
    });
    const run = await history(hre, { key: "deployer", ...SETTLED });

    assert.match(
      run.stdout,
      /^No sign events found before the reader stopped \(it stopped before reading the whole range\)\.$/m,
    );
    assert.doesNotMatch(run.stdout, /No sign events in /);
    assert.match(
      run.stderr,
      /The reader found no sign events before it stopped\. That does not show/,
    );
    assert.match(
      run.stderr,
      /the reader stopped before reading the whole range and found no sign events before it stopped, so the range may hold events it did not read\./,
    );
  });

  it("prints the scope with ids hidden, and says when the reader stopped early", async () => {
    const reader = fakeHistoryReader("myvault", (request) =>
      historyResult({
        events: [historyEvent({ time: request.until.toISOString() })],
        truncated: true,
        truncatedReason: "scan-limit",
        scope: { description: "us-east-1", ids: { account: "999988887777" } },
      }),
    );
    const hre = await runtime({ readers: [reader.handlers] });

    const run = await history(hre, { key: "deployer", ...SETTLED });

    assert.match(run.stdout, /^Scope: account <hidden>, us-east-1$/m);
    assert.doesNotMatch(run.stdout, /999988887777/);
    assert.match(
      run.stderr,
      /the reader stopped before reading the whole range; these are the newest 1 event it found, so the range may hold events it did not read\./,
    );
    assert.doesNotMatch(run.stderr, /than --limit/);
  });

  it("keeps the newest events up to --limit and says the log holds more", async () => {
    const reader = fakeHistoryReader("myvault", (request) =>
      historyResult({
        events: [1, 2, 3].map((hour) =>
          historyEvent({
            time: new Date(request.until.getTime() - hour * HOUR).toISOString(),
            requestId: `r${hour}`,
          }),
        ),
      }),
    );
    const hre = await runtime({ readers: [reader.handlers] });

    const run = await history(hre, { key: "deployer", ...SETTLED, limit: 2, json: true });

    assert.deepEqual(
      run.report?.events.map((event) => event.requestId),
      ["r1", "r2"],
    );
    assert.equal(run.report?.truncated, true);
    assert.match(
      run.stderr,
      /the log holds more events in this range than --limit 2; these are the newest 2 events\. Narrow the range with --since and --until, or raise --limit\./,
    );
  });
});
