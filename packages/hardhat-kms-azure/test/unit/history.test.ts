import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AzureKmsKeyConfig, KmsAuditConfig, KmsHistoryRequest } from "hardhat-kms/types";

import {
  keyTarget,
  kqlString,
  type QueryAnswer,
  type QueryRequest,
  readAzureSignHistory,
  signEventsQuery,
} from "../../src/internal/history.ts";
import {
  ASSIGNMENT_ID,
  CLI_APP_ID,
  FAILED_SIGN,
  KEY_URL,
  NO_TABLE_ERROR,
  PLUGIN_SIGN,
  PLUGIN_USER_AGENT,
  queryBody,
  REQUEST_ID,
  SERVICE_PRINCIPAL_SIGN,
  SP_APP_ID,
  SP_OBJECT_ID,
  USER,
  USER_OBJECT_ID,
  VAULT_HOST,
  VERSION_1,
  VERSION_2,
  WORKSPACE_ID,
  WORKSPACE_NOT_FOUND_ERROR,
} from "../fixtures/log-analytics-rows.ts";

const SINCE = new Date("2026-10-01T10:00:00Z");
const UNTIL = new Date("2026-10-02T11:00:00Z");

function azureKey(keyId: string = KEY_URL): AzureKmsKeyConfig {
  return {
    provider: "azure",
    name: "deployer",
    displayId: "azure:<HHKMS_KEY>",
    timeoutMs: 30_000,
    keyId: { get: async () => await Promise.resolve(keyId), display: "<HHKMS_KEY>" },
  };
}

function audit(workspaceId: string = WORKSPACE_ID): KmsAuditConfig {
  return {
    azure: { workspaceId: { get: async () => await Promise.resolve(workspaceId), display: "w" } },
  };
}

function historyRequest(overrides: Partial<KmsHistoryRequest> = {}): KmsHistoryRequest {
  return {
    key: azureKey(),
    since: SINCE,
    until: UNTIL,
    limit: 100,
    signal: new AbortController().signal,
    ...overrides,
  };
}

interface Call {
  workspaceId: string;
  request: QueryRequest;
  signal: AbortSignal;
}

/** A query call that records its calls and gives the answers in order. */
function fakeQuery(...answers: Array<QueryAnswer | Error>) {
  const calls: Call[] = [];
  const query = async (
    workspaceId: string,
    request: QueryRequest,
    signal: AbortSignal,
  ): Promise<QueryAnswer> => {
    calls.push({ workspaceId, request, signal });
    const answer = answers.shift();
    if (answer === undefined) {
      throw new Error("no answer left");
    }
    if (answer instanceof Error) {
      throw answer;
    }
    return await Promise.resolve(answer);
  };
  return { calls, query };
}

const ok = (rows: Parameters<typeof queryBody>[0]): QueryAnswer => ({
  status: 200,
  body: queryBody(rows),
});

async function read(
  answers: Array<QueryAnswer | Error>,
  options: {
    key?: AzureKmsKeyConfig;
    audit?: KmsAuditConfig;
    request?: Partial<KmsHistoryRequest>;
  } = {},
) {
  const { calls, query } = fakeQuery(...answers);
  const result = await readAzureSignHistory(
    options.key ?? azureKey(),
    options.audit ?? audit(),
    historyRequest(options.request),
    query,
  );
  return { result, calls };
}

async function readError(
  answers: Array<QueryAnswer | Error>,
  options: Parameters<typeof read>[1] = {},
): Promise<{ error: Error; calls: Call[] }> {
  const { calls, query } = fakeQuery(...answers);
  try {
    await readAzureSignHistory(
      options.key ?? azureKey(),
      options.audit ?? audit(),
      historyRequest(options.request),
      query,
    );
  } catch (error) {
    assert.ok(error instanceof Error);
    return { error, calls };
  }
  return assert.fail("the read did not fail");
}

/** An error with this name, whose message names the key. */
function named(name: string, fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`${name} for ${KEY_URL}`), { name, ...fields });
}

/** A KQL query with each string literal emptied. */
function blank(text: string): string {
  return text.replaceAll(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** Every obfuscated `h"…"` string literal of a KQL query, with its escapes undone. */
function hidden(query: string): string[] {
  return [...query.matchAll(/\bh"((?:[^"\\]|\\.)*)"/g)].map(([, body = ""]) =>
    body.replaceAll(/\\(.)/g, "$1"),
  );
}

describe("the Azure history reader", () => {
  describe("mapping", () => {
    it("copies each field of a plugin sign row", async () => {
      const { result } = await read([ok([PLUGIN_SIGN])]);
      assert.equal(result.source, "log-analytics");
      assert.deepEqual(result.notLogged, ["digest"]);
      assert.equal(result.completeForKey, false);
      assert.equal(result.truncated, false);
      assert.equal(result.deliveryDelayMinutes, 10);
      assert.equal(result.retentionDays, undefined);
      assert.deepEqual(result.events, [
        {
          time: "2026-10-02T09:06:13.8719275Z",
          operation: "KeySign",
          outcome: "success",
          errorCode: null,
          errorMessage: null,
          principal: USER,
          sourceIp: "203.0.113.7",
          userAgent: PLUGIN_USER_AGENT,
          requestId: REQUEST_ID,
          keyVersion: VERSION_1,
          digest: null,
          keyResource: `${KEY_URL}/${VERSION_1}`,
          extra: {
            resultType: "Success",
            resultSignature: "OK",
            httpStatusCode: 200,
            algorithm: "ES256K",
            durationMs: 333,
            operationVersion: "2025-07-01",
            identityType: "user",
            isRbacAuthorized: true,
            tlsVersion: "TLS1_3",
          },
          extraIds: {
            objectId: USER_OBJECT_ID,
            appId: CLI_APP_ID,
            appliedAssignmentId: ASSIGNMENT_ID,
          },
        },
      ]);
    });

    it("reports a refused request by its HTTP status, though its ResultType says Success", async () => {
      const { result } = await read([ok([FAILED_SIGN])]);
      const [event] = result.events;
      assert.equal(event?.outcome, "failed");
      assert.equal(event?.errorCode, "Bad Request");
      assert.match(String(event?.errorMessage), /^Key and signing algorithm are incompatible/);
      assert.equal(event?.extra?.httpStatusCode, 400);
      // An empty column is left out, not shown as an empty string.
      assert.equal(event?.extra?.algorithm, undefined);
    });

    it("names an application by its application id, and keeps its object id hidden", async () => {
      const { result } = await read([ok([SERVICE_PRINCIPAL_SIGN])]);
      const [event] = result.events;
      assert.equal(event?.principal, SP_APP_ID);
      assert.equal(event?.keyVersion, VERSION_2);
      assert.deepEqual(event?.extraIds, {
        objectId: SP_OBJECT_ID,
        appliedAssignmentId: ASSIGNMENT_ID,
      });
      assert.equal(event?.extra?.identityType, "app");
    });

    it("prefers the user principal name, in its short or long claim name", async () => {
      for (const name of ["upn", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn"]) {
        const identity = JSON.stringify({
          claim: { [name]: "signer@example.com", unique_name: USER, oid: USER_OBJECT_ID },
        });
        const { result } = await read([ok([{ ...PLUGIN_SIGN, Identity: identity }])]);
        assert.equal(result.events[0]?.principal, "signer@example.com");
      }
    });

    it("names a user with no name claim by object id, never by the client's application id", async () => {
      const identity = {
        claim: {
          "http://schemas.microsoft.com/identity/claims/objectidentifier": USER_OBJECT_ID,
          appid: CLI_APP_ID,
          idtyp: "user",
        },
      };
      // An object, as well as the JSON text the API sends.
      const { result } = await read([ok([{ ...PLUGIN_SIGN, Identity: identity }])]);
      assert.equal(result.events[0]?.principal, USER_OBJECT_ID);
      assert.deepEqual(result.events[0]?.extraIds, {
        appId: CLI_APP_ID,
        appliedAssignmentId: ASSIGNMENT_ID,
      });
    });

    it("tells an application's token from a user's by idtyp, else by the scp claim", async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        // A delegated token without idtyp: a user, so not the client application's id.
        [{ oid: USER_OBJECT_ID, appid: CLI_APP_ID, scp: "user_impersonation" }, USER_OBJECT_ID],
        // No idtyp and no scp: an application.
        [{ oid: SP_OBJECT_ID, appid: SP_APP_ID }, SP_APP_ID],
        [{ oid: SP_OBJECT_ID, appid: SP_APP_ID, idtyp: "app", scp: "x" }, SP_APP_ID],
        [{ oid: USER_OBJECT_ID, appid: CLI_APP_ID, idtyp: "user" }, USER_OBJECT_ID],
      ];
      for (const [claims, principal] of cases) {
        const Identity = JSON.stringify({ claim: claims });
        const { result } = await read([ok([{ ...PLUGIN_SIGN, Identity }])]);
        assert.equal(result.events[0]?.principal, principal, JSON.stringify(claims));
      }
    });

    it("leaves the principal empty when the identity is missing or not JSON", async () => {
      for (const Identity of [null, "", "{not json", "[]"]) {
        const { result } = await read([ok([{ ...PLUGIN_SIGN, Identity }])]);
        assert.equal(result.events[0]?.principal, null);
      }
    });

    it("reads the key version from RequestUri, with its port, when Id is empty", async () => {
      const { result } = await read([ok([{ ...PLUGIN_SIGN, Id: "" }])]);
      assert.equal(result.events[0]?.keyVersion, VERSION_1);
      assert.match(String(result.events[0]?.keyResource), /:8443\/keys\/deployer\//);
    });

    it("leaves the key version empty when the URL has none or is not a URL", async () => {
      for (const Id of [KEY_URL, "not a url", `${KEY_URL}/bad_version!`]) {
        const { result } = await read([ok([{ ...PLUGIN_SIGN, Id }])]);
        assert.equal(result.events[0]?.keyVersion, null);
      }
      const { result } = await read([ok([{ ...PLUGIN_SIGN, Id: null, RequestUri: null }])]);
      assert.equal(result.events[0]?.keyVersion, null);
      assert.equal(result.events[0]?.keyResource, null);
    });

    it("falls back to ResultType when a row has no HTTP status", async () => {
      const { result } = await read([
        ok([
          { ...PLUGIN_SIGN, HttpStatusCode: null, ResultType: "Success" },
          { ...PLUGIN_SIGN, HttpStatusCode: null, ResultType: "Unauthorized", ResultSignature: "" },
        ]),
      ]);
      assert.deepEqual(
        result.events.map((event) => [event.outcome, event.errorCode]),
        [
          ["success", null],
          ["failed", "Unauthorized"],
        ],
      );
      const { result: byStatus } = await read([
        ok([{ ...PLUGIN_SIGN, HttpStatusCode: 403, ResultSignature: "" }]),
      ]);
      assert.equal(byStatus.events[0]?.errorCode, "403");
    });

    it("refuses a row with neither an HTTP status nor a result type", async () => {
      const { error } = await readError([
        ok([{ ...PLUGIN_SIGN, HttpStatusCode: null, ResultType: "" }]),
      ]);
      assert.match(error.message, /neither an HTTP status nor a result type/);
    });

    it("leaves out a row outside the range", async () => {
      const { result } = await read([ok([PLUGIN_SIGN, SERVICE_PRINCIPAL_SIGN])], {
        request: { since: new Date("2026-10-02T09:00:00Z") },
      });
      assert.deepEqual(
        result.events.map((event) => event.requestId),
        [REQUEST_ID],
      );
    });

    it("puts the workspace in the scope ids and the vault host in the hidden values", async () => {
      const { result } = await read([ok([])]);
      assert.deepEqual(result.events, []);
      assert.deepEqual(result.scope?.ids, { workspace: WORKSPACE_ID });
      assert.deepEqual(result.hiddenValues, [VAULT_HOST]);
      // Printed without --show-ids, so none of these holds an id.
      for (const text of [result.source, result.scope?.description, result.setupHint]) {
        assert.doesNotMatch(String(text), /[0-9a-f]{8}-|vault\.azure\.net|deployer/);
      }
      assert.match(String(result.setupHint), /diagnostic setting/);
    });
  });

  describe("truncation", () => {
    it("returns limit + 1 rows and marks the result truncated by limit", async () => {
      const { result, calls } = await read(
        [ok([FAILED_SIGN, PLUGIN_SIGN, SERVICE_PRINCIPAL_SIGN])],
        { request: { limit: 2 } },
      );
      assert.match(calls[0]?.request.query ?? "", /\| take 3\n/);
      assert.equal(result.events.length, 3);
      assert.equal(result.truncated, true);
      assert.equal(result.truncatedReason, "limit");
    });

    it("counts the rows the query returned, not the rows left in the range", async () => {
      const outside = { ...PLUGIN_SIGN, TimeGenerated: "2026-09-01T00:00:00Z" };
      const { result } = await read([ok([PLUGIN_SIGN, outside])], { request: { limit: 1 } });
      assert.equal(result.events.length, 1);
      assert.equal(result.truncated, true);
      assert.equal(result.truncatedReason, "limit");
      // Fewer than limit events left: the read is marked as stopped short, which the core takes.
      const { result: short } = await read([ok([PLUGIN_SIGN, outside, outside])], {
        request: { limit: 2 },
      });
      assert.equal(short.events.length, 1);
      assert.equal(short.truncatedReason, "scan-limit");
    });

    it("is not truncated when the rows fit the limit", async () => {
      const { result } = await read([ok([FAILED_SIGN, PLUGIN_SIGN])], { request: { limit: 2 } });
      assert.equal(result.truncated, false);
      assert.equal(result.truncatedReason, undefined);
    });
  });

  describe("the query", () => {
    it("matches the key by host and name, without regard to case, over the range", async () => {
      const { calls } = await read([ok([])], {
        key: azureKey(`https://EXAMPLE-Vault.vault.azure.net/keys/Deployer/${VERSION_1}`),
      });
      const [call] = calls;
      assert.equal(call?.workspaceId, WORKSPACE_ID);
      assert.equal(call?.request.timespan, "2026-10-01T10:00:00.000Z/2026-10-02T11:00:00.001Z");
      assert.equal(
        call?.request.query,
        [
          "AZKVAuditLogs",
          "| where TimeGenerated >= datetime(2026-10-01T10:00:00.000Z) and TimeGenerated < datetime(2026-10-02T11:00:00.001Z)",
          '| where OperationName == "KeySign"',
          "| extend hkmsUrl = parse_url(iff(isnotempty(Id), Id, RequestUri))",
          '| extend hkmsPath = split(tostring(hkmsUrl.Path), "/")',
          '| where tostring(hkmsUrl.Host) =~ h"example-vault.vault.azure.net"',
          '| where tostring(hkmsPath[1]) =~ "keys" and tostring(hkmsPath[2]) =~ h"Deployer"',
          "| order by TimeGenerated desc",
          "| take 101",
          [
            "| project TimeGenerated, OperationName",
            'ResultType = column_ifexists("ResultType", "")',
            'ResultSignature = column_ifexists("ResultSignature", "")',
            'ResultDescription = column_ifexists("ResultDescription", "")',
            'HttpStatusCode = column_ifexists("HttpStatusCode", int(null))',
            'CorrelationId = column_ifexists("CorrelationId", "")',
            'CallerIpAddress = column_ifexists("CallerIpAddress", "")',
            'ClientInfo = column_ifexists("ClientInfo", "")',
            'Identity = column_ifexists("Identity", dynamic(null))',
            "Id, RequestUri",
            'Algorithm = column_ifexists("Algorithm", "")',
            'DurationMs = column_ifexists("DurationMs", int(null))',
            'OperationVersion = column_ifexists("OperationVersion", "")',
            'IsRbacAuthorized = column_ifexists("IsRbacAuthorized", bool(null))',
            'IsAccessPolicyMatch = column_ifexists("IsAccessPolicyMatch", bool(null))',
            'AppliedAssignmentId = column_ifexists("AppliedAssignmentId", "")',
            'Tlsversion = column_ifexists("Tlsversion", "")',
            'SubnetId = column_ifexists("SubnetId", "")',
          ].join(", "),
        ].join("\n"),
      );
      // A pinned version still reads every version of the key.
      assert.doesNotMatch(call?.request.query ?? "", new RegExp(VERSION_1));
    });

    it("escapes quotes and backslashes in a KQL string", () => {
      assert.equal(kqlString('a"b\\c'), String.raw`h"a\"b\\c"`);
      assert.deepEqual(hidden(`x == ${kqlString('a"b\\c')}`), ['a"b\\c']);
    });

    it("cannot be changed by a hostile key id: each is refused before any query", async () => {
      const hostile = [
        'https://evil".vault.azure.net/keys/k',
        'https://v.vault.azure.net/keys/k"|union*',
        "https://v.vault.azure.net/keys/k%22%7Cunion",
        String.raw`https://v.vault.azure.net/keys/k\x`,
        "https://v.vault.azure.net/keys/a b",
        "https://v.vault.azure.net/keys/k'or'1",
        "https://v.vault.azure.net/keys/k\n| take 1",
        "https://v.vault.azure.net/keys/k;drop",
        'https://v.vault.azure.net/keys/k" or 1==1 or "',
        "https://v.vault.azure.net:8443/keys/k",
        "https://user@v.vault.azure.net/keys/k",
        "https://v.vault.azure.net/keys/k?x=1",
        "https://v.vault.azure.net/keys/k#x",
        "https://evil.example.com/keys/k",
        "https://v.vault.azure.net/secrets/k",
        "not a url",
      ];
      for (const keyId of hostile) {
        const { error, calls } = await readError([ok([])], { key: azureKey(keyId) });
        assert.match(error.message, /no Log Analytics query is built/, keyId);
        assert.equal(calls.length, 0, keyId);
      }
    });

    it("quotes only checked values for the key ids it accepts", async () => {
      const accepted = [
        "https://v.vault.azure.net/keys/k",
        "https://V.VAULT.AZURE.NET/keys/A-b-9",
        "https://xn--nx-xka.vault.azure.net/keys/k",
        "https://ünx.vault.azure.net/keys/k",
        "https://v.vault.azure.net:443/keys/k/",
        // The URL parser resolves the path first: this is the key "x".
        "https://v.vault.azure.net/keys/k/../x",
        `https://v.vault.azure.net/keys/${"k".repeat(127)}`,
      ];
      for (const keyId of accepted) {
        const { calls } = await read([ok([])], { key: azureKey(keyId) });
        const query = calls[0]?.request.query ?? "";
        const target = keyTarget(keyId);
        assert.ok(typeof target === "object", keyId);
        assert.deepEqual(hidden(query), [target.host, target.keyName], keyId);
        for (const value of [target.host, target.keyName]) {
          assert.match(value, /^[A-Za-z0-9.-]+$/, keyId);
        }
        // Nothing outside the literals comes from the key id: the rest of the query is fixed.
        assert.equal(
          blank(query),
          blank(signEventsQuery({ host: "h", keyName: "k" }, SINCE, UNTIL, 101)),
          keyId,
        );
      }
    });

    it("never builds a query with an unchecked value, for any key name", () => {
      // Every printable ASCII character in a key name: only [0-9A-Za-z-] passes.
      for (let code = 0x20; code < 0x7f; code++) {
        const char = String.fromCharCode(code);
        const target = keyTarget(`https://v.vault.azure.net/keys/a${encodeURIComponent(char)}b`);
        if (typeof target === "object") {
          assert.match(target.keyName, /^[0-9A-Za-z-]+$/, JSON.stringify(char));
        }
      }
    });
  });

  describe("refusals", () => {
    it("fails, naming the setting, when kms.audit.azure.workspaceId is not set", async () => {
      const { error, calls } = await readError([ok([])], { audit: {} });
      assert.match(error.message, /kms\.audit\.azure\.workspaceId is not set/);
      assert.equal(calls.length, 0);
    });

    it("refuses a workspace id that is not a GUID", async () => {
      for (const workspaceId of ["my-workspace", `${WORKSPACE_ID}/../x`, ""]) {
        const { error, calls } = await readError([ok([])], { audit: audit(workspaceId) });
        assert.match(error.message, /is not a GUID/);
        assert.equal(calls.length, 0);
      }
    });

    it("does not read Managed HSM keys yet, rather than return no events", async () => {
      const { error, calls } = await readError([ok([])], {
        key: azureKey("https://my-hsm.managedhsm.azure.net/keys/k"),
      });
      assert.match(error.message, /does not support Managed HSM keys yet/);
      assert.equal(calls.length, 0);
    });

    it("refuses a vault outside Azure's public cloud", async () => {
      for (const host of ["v.vault.azure.cn", "v.vault.usgovcloudapi.net"]) {
        const { error, calls } = await readError([ok([])], {
          key: azureKey(`https://${host}/keys/k`),
        });
        assert.match(error.message, /only vaults in Azure's public cloud/);
        assert.equal(calls.length, 0);
      }
    });
  });

  describe("answers", () => {
    it("says the workspace has no AZKVAuditLogs table, rather than no events", async () => {
      const { error } = await readError([{ status: 400, body: NO_TABLE_ERROR }]);
      assert.match(error.message, /has no AZKVAuditLogs table/);
      assert.match(error.message, /resource-specific/);
    });

    it("shows the codes, not the message, of another bad request", async () => {
      const other = structuredClone(NO_TABLE_ERROR);
      other.error.innererror.innererror.message =
        "Failed to resolve scalar expression named 'Nope' in workspace example-vault";
      const { error } = await readError([{ status: 400, body: other }]);
      assert.match(error.message, /query failed \(400 BadArgumentError SemanticError SEM0100\)/);
      assert.doesNotMatch(error.message, /example-vault|Nope/);
    });

    it("names both permissions when the read is refused", async () => {
      const { error } = await readError([
        {
          status: 403,
          body: { error: { code: "InsufficientAccessError", message: "on workspace x" } },
        },
      ]);
      assert.match(
        error.message,
        /Microsoft\.OperationalInsights\/workspaces\/query\/read and Microsoft\.OperationalInsights\/workspaces\/query\/AZKVAuditLogs\/read/,
      );
    });

    it("reports throttling with the documented limit", async () => {
      const { error } = await readError([{ status: 429, body: undefined }]);
      assert.match(error.message, /200 per 30 seconds/);
    });

    it("explains 401, an unknown workspace and other statuses", async () => {
      const cases: Array<[QueryAnswer, RegExp]> = [
        [
          { status: 401, body: { error: { code: "InvalidTokenError" } } },
          /answered 401 InvalidTokenError: the credential was not accepted/,
        ],
        [{ status: 404, body: WORKSPACE_NOT_FOUND_ERROR }, /found no workspace with the id/],
        [{ status: 404, body: undefined }, /query failed \(404\)/],
        [{ status: 503, body: "busy" }, /query failed \(503\)/],
        [
          { status: 500, body: { error: { code: "has spaces and <tags>" } } },
          /query failed \(500\)/,
        ],
      ];
      for (const [answer, expected] of cases) {
        const { error } = await readError([answer]);
        assert.match(error.message, expected);
      }
    });

    it("fails on a partial result rather than show part of the history", async () => {
      const { error } = await readError([
        {
          status: 200,
          body: {
            ...queryBody([PLUGIN_SIGN]),
            error: { code: "PartialError", innererror: { code: "LimitsExceeded" } },
          },
        },
      ]);
      assert.match(
        error.message,
        /part of the result with an error \(PartialError LimitsExceeded\)/,
      );
      const { error: noCode } = await readError([
        { status: 200, body: { ...queryBody([]), error: {} } },
      ]);
      assert.match(noCode.message, /\(no code\)/);
    });

    it("fails on an answer it cannot read", async () => {
      const cases: Array<[unknown, RegExp]> = [
        [undefined, /no table with columns and rows/],
        [{ tables: [] }, /no table with columns and rows/],
        [{ tables: [{ columns: [{ name: "Id" }], rows: [] }] }, /no TimeGenerated or/],
        [{ ...queryBody([]), tables: [{ ...queryBody([]).tables[0], rows: [7] }] }, /not a list/],
        [queryBody([{ ...PLUGIN_SIGN, TimeGenerated: "" }]), /no TimeGenerated or/],
        [queryBody([{ ...PLUGIN_SIGN, TimeGenerated: "yesterday" }]), /not a date/],
      ];
      for (const [body, expected] of cases) {
        const { error } = await readError([{ status: 200, body }]);
        assert.match(error.message, /answered in a form this plugin does not read/);
        assert.match(error.message, expected);
      }
    });
  });

  describe("thrown errors", () => {
    it("explains a credential chain with no token", async () => {
      const { error } = await readError([named("CredentialUnavailableError")]);
      assert.match(
        error.message,
        /no Azure credential returned a token \(CredentialUnavailableError\)/,
      );
      const { error: failed } = await readError([named("AuthenticationError")]);
      assert.match(failed.message, /could not sign in \(AuthenticationError\)/);
    });

    it("explains a query that got no answer, by its code only", async () => {
      const { error } = await readError([named("RestError", { code: "ENOTFOUND" })]);
      assert.match(error.message, /could not reach Log Analytics \(ENOTFOUND\)/);
      const { error: odd } = await readError([named("RestError", { code: "a b" })]);
      assert.match(odd.message, /\(no code\)/);
    });

    it("passes other errors on", async () => {
      const other = new TypeError("boom");
      const { error } = await readError([other]);
      assert.equal(error, other);
      // An error whose name is not a string is passed on as it is.
      const unnamed = Object.defineProperty(new Error("unnamed"), "name", { value: 7 });
      const { error: passed } = await readError([unnamed]);
      assert.equal(passed, unnamed);
    });
  });

  describe("the signal", () => {
    it("does not query once the signal has aborted", async () => {
      const controller = new AbortController();
      controller.abort(new Error("stop"));
      const { error, calls } = await readError([ok([])], {
        request: { signal: controller.signal },
      });
      assert.equal(error.message, "stop");
      assert.equal(calls.length, 0);
    });

    it("passes the signal to the query and stops with it", async () => {
      const controller = new AbortController();
      const { calls, query } = fakeQuery();
      const pending = readAzureSignHistory(
        azureKey(),
        audit(),
        historyRequest({ signal: controller.signal }),
        async (workspaceId, request, signal) => {
          calls.push({ workspaceId, request, signal });
          controller.abort(new Error("stop"));
          // The query call rejects with its own error once the signal aborts.
          return await query(workspaceId, request, signal);
        },
      );
      await assert.rejects(pending, /stop/);
      assert.equal(calls[0]?.signal, controller.signal);
    });

    it("works without a signal", async () => {
      const { query } = fakeQuery(ok([PLUGIN_SIGN]));
      const { signal: _signal, ...request } = historyRequest();
      const result = await readAzureSignHistory(azureKey(), audit(), request, query);
      assert.equal(result.events.length, 1);
    });
  });
});
