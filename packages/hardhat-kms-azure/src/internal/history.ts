// The Azure reader of `kms history`: lists a key's KeySign events from the AZKVAuditLogs table of
// the Log Analytics workspace set in `kms.audit.azure.workspaceId`, through the Log Analytics
// query API. It takes the call as an argument, so tests pass a fake; log-analytics.ts makes the
// real one.
import {
  auditLogAccessDenied,
  auditLogThrottled,
  catalogError,
  type ErrorEntry,
  parseAzureKeyId,
  type TemplateParams,
} from "hardhat-kms/provider-utils";
import type {
  AzureKmsKeyConfig,
  KmsAuditConfig,
  KmsHistoryEvent,
  KmsHistoryExtraValue,
  KmsHistoryRequest,
  KmsHistoryResult,
} from "hardhat-kms/types";

import { ERRORS } from "./error-catalog.ts";

/** The body of a Log Analytics query request. */
export interface QueryRequest {
  /** The KQL query. */
  query: string;
  /** The range the query may read, as an ISO 8601 interval. */
  timespan: string;
}

/** A Log Analytics answer: the HTTP status and the parsed JSON body, if any. */
export interface QueryAnswer {
  status: number;
  body: unknown;
}

/**
 * One Log Analytics query. It resolves with the answer for any HTTP status, and rejects only when
 * no answer came: a network error, a credential that returned no token, or an abort.
 */
export type QueryWorkspace = (
  workspaceId: string,
  request: QueryRequest,
  signal: AbortSignal,
) => Promise<QueryAnswer>;

/** The `source` of every result. */
const SOURCE = "log-analytics";

/** The table that a vault's diagnostic setting fills in resource-specific mode. */
const TABLE = "AZKVAuditLogs";

/** Key Vault's name for a sign request in its audit log, checked live. */
const OPERATION = "KeySign";

/**
 * Key Vault documents that audit events reach the destination "10 minutes (at most) after the key
 * vault operation". Log Analytics ingestion adds its own delay, measured at up to about 9 minutes,
 * before a row is queryable.
 */
const DELIVERY_DELAY_MINUTES = 10;

/** Log Analytics' query limit per user, which a throttled read hits. */
const THROTTLE_LIMIT = "200 per 30 seconds";

/** What reading the table needs, as the Log Analytics Data Reader role grants it. */
const READ_PERMISSIONS: readonly string[] = [
  "Microsoft.OperationalInsights/workspaces/query/read",
  `Microsoft.OperationalInsights/workspaces/query/${TABLE}/read`,
];

const SETUP_HINT =
  "Check that a diagnostic setting on the vault sends the AuditEvent category to this workspace with the resource-specific destination, that kms.audit.azure.workspaceId names that workspace and not another one a second setting sends to, and that the identity may read the AZKVAuditLogs table, since a read limited to other tables may get no rows from it.";

const SCOPE_DESCRIPTION = `${TABLE} in one Log Analytics workspace, every version of the key`;

/** The vault hosts of Azure's public cloud, whose workspaces answer on `api.loganalytics.azure.com`. */
const PUBLIC_VAULT_SUFFIX = ".vault.azure.net";
const MANAGED_HSM = /\.managedhsm\./;

const WORKSPACE_ID = /^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;
// The characters a host and a key name may hold here. None of them means anything inside a KQL
// string literal, so neither can change the query.
const HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const KEY_NAME = /^[0-9A-Za-z-]{1,127}$/;
const KEY_VERSION = /^[0-9A-Za-z]{1,64}$/;
/** A code from an answer, shown only when it has this shape. */
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * The columns the query returns, in this order. The query names the first four directly, since it
 * filters on them; the others through `column_ifexists`, with these defaults, so that a column a
 * workspace lacks reads as empty instead of failing the query.
 */
const OPTIONAL_DEFAULTS: Readonly<Record<string, string>> = {
  HttpStatusCode: "int(null)",
  DurationMs: "int(null)",
  Identity: "dynamic(null)",
  IsRbacAuthorized: "bool(null)",
  IsAccessPolicyMatch: "bool(null)",
};
const REQUIRED_COLUMNS: readonly string[] = ["TimeGenerated", "OperationName", "Id", "RequestUri"];

/** The columns the query returns, in this order. */
export const COLUMNS = [
  "TimeGenerated",
  "OperationName",
  "ResultType",
  "ResultSignature",
  "ResultDescription",
  "HttpStatusCode",
  "CorrelationId",
  "CallerIpAddress",
  "ClientInfo",
  "Identity",
  "Id",
  "RequestUri",
  "Algorithm",
  "DurationMs",
  "OperationVersion",
  "IsRbacAuthorized",
  "IsAccessPolicyMatch",
  "AppliedAssignmentId",
  "Tlsversion",
  "SubnetId",
] as const;

type Column = (typeof COLUMNS)[number];

/** The parts of a key's URL the query is built from. */
export interface KeyTarget {
  /** The vault host, lowercase, such as `my-vault.vault.azure.net`. */
  host: string;
  /** The key name, as configured. */
  keyName: string;
}

/**
 * A KQL obfuscated string literal, `h"…"`, with `\` and `"` escaped. The `h` keeps the value out
 * of the workspace's query audit log (`LAQueryLogs`). The reader only quotes values it has checked
 * against {@link HOST} or {@link KEY_NAME}, which hold neither; the escaping is a second guard.
 *
 * @param value - The value.
 * @returns The literal.
 */
export function kqlString(value: string): string {
  return `h"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * The exclusive end of a range whose inclusive end is `until`: rows carry fractions of a
 * millisecond, so the read goes up to the next millisecond.
 */
function exclusiveEnd(until: Date): Date {
  return new Date(until.getTime() + 1);
}

/** One projected column: by name, or through `column_ifexists` with its default. */
function projected(column: string): string {
  if (REQUIRED_COLUMNS.includes(column)) {
    return column;
  }
  return `${column} = column_ifexists("${column}", ${OPTIONAL_DEFAULTS[column] ?? '""'})`;
}

/** A KQL `datetime` literal for an instant. */
function kqlDatetime(date: Date): string {
  return `datetime(${date.toISOString()})`;
}

/**
 * The KQL query for a key's sign events in a range, newest first. It matches the key by the host
 * and key name of each row's key URL (`Id`, or `RequestUri` when `Id` is empty), without regard
 * to case and whatever the version, rather than by the whole URL: `RequestUri` carries a port.
 *
 * @param target - The checked host and key name.
 * @param since - The start of the range, inclusive.
 * @param until - The end of the range, inclusive, on a whole second.
 * @param take - The most rows to return.
 * @returns The query.
 */
export function signEventsQuery(target: KeyTarget, since: Date, until: Date, take: number): string {
  return [
    TABLE,
    `| where TimeGenerated >= ${kqlDatetime(since)} and TimeGenerated < ${kqlDatetime(exclusiveEnd(until))}`,
    `| where OperationName == "${OPERATION}"`,
    "| extend hkmsUrl = parse_url(iff(isnotempty(Id), Id, RequestUri))",
    '| extend hkmsPath = split(tostring(hkmsUrl.Path), "/")',
    `| where tostring(hkmsUrl.Host) =~ ${kqlString(target.host)}`,
    `| where tostring(hkmsPath[1]) =~ "keys" and tostring(hkmsPath[2]) =~ ${kqlString(target.keyName)}`,
    "| order by TimeGenerated desc",
    `| take ${String(Math.trunc(take))}`,
    `| project ${COLUMNS.map(projected).join(", ")}`,
  ].join("\n");
}

/** Why the key cannot be read, before any query is sent. */
type TargetProblem = "key-id" | "managed-hsm" | "sovereign-cloud";

/**
 * Reads the host and key name of a key URL for the query.
 *
 * @param keyId - The key URL.
 * @returns The parts, or why the reader does not query this key.
 */
export function keyTarget(keyId: string): KeyTarget | TargetProblem {
  const parsed = parseAzureKeyId(keyId);
  if (parsed === undefined) {
    return "key-id";
  }
  const host = new URL(parsed.vaultUrl).hostname.toLowerCase();
  if (!HOST.test(host) || !KEY_NAME.test(parsed.keyName)) {
    return "key-id";
  }
  if (MANAGED_HSM.test(host)) {
    return "managed-hsm";
  }
  if (!host.endsWith(PUBLIC_VAULT_SUFFIX)) {
    return "sovereign-cloud";
  }
  return { host, keyName: parsed.keyName };
}

/** Why an answer could not be read; the text is the reader's own, with no value from the answer. */
class BadResponse extends Error {
  public override readonly name = "BadResponse";
}

/** Reads a property of a value that may not be an object. */
function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

/** A non-empty string, or `null`. */
function textOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** An integer, or `null`. */
function integerOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** A boolean, or `null`. */
function booleanOf(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * A dynamic column's value. The query API returns dynamic values as JSON text; an object is read
 * as it is.
 */
function dynamicOf(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** The first claim of `names` that is a non-empty string. */
function claim(claims: unknown, names: readonly string[]): string | null {
  for (const name of names) {
    const value = textOf(field(claims, name));
    if (value !== null) {
      return value;
    }
  }
  return null;
}

// Token claims, by their short names and the long ones some tokens carry.
const UPN = ["upn", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn"];
const UNIQUE_NAME = ["unique_name"];
const OBJECT_ID = ["oid", "http://schemas.microsoft.com/identity/claims/objectidentifier"];
const APP_ID = ["appid"];
const IDENTITY_TYPE = ["idtyp"];

/**
 * Who made the request, from the token claims the row logs, and the claims that identify the
 * caller without being shown as the principal.
 *
 * The principal is the user principal name, else the unique name, else, for an application, the
 * application id, else the object id. A token is an application's when its `idtyp` claim says
 * `app`, or when it has no `idtyp` and no `scp` (delegated scopes) claim. For a user, the
 * application id names the client application, such as the Azure CLI, not the caller, so it is
 * never the principal.
 */
function principalOf(identity: unknown): {
  principal: string | null;
  identityType: string | null;
  ids: Record<string, string>;
} {
  const claims = field(identity, "claim");
  const objectId = claim(claims, OBJECT_ID);
  const appId = claim(claims, APP_ID);
  const identityType = claim(claims, IDENTITY_TYPE);
  const application =
    identityType === "app" || (identityType === null && field(claims, "scp") === undefined);
  const principal =
    claim(claims, UPN) ?? claim(claims, UNIQUE_NAME) ?? (application ? appId : null) ?? objectId;
  // A value shown as the principal is not also an id: ids are masked wherever they appear.
  const ids: Record<string, string> = {};
  if (objectId !== null && objectId !== principal) {
    ids.objectId = objectId;
  }
  if (appId !== null && appId !== principal) {
    ids.appId = appId;
  }
  return { principal, identityType, ids };
}

/** The key version in a key URL's path: `/keys/<name>/<version>[/…]`. */
function versionOf(url: string | null): string | null {
  if (url === null) {
    return null;
  }
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const version = path.split("/")[3];
  return version !== undefined && KEY_VERSION.test(version) ? version : null;
}

/** Whether the row's request failed: by its HTTP status, else by its result type. */
function failedOf(status: number | null, resultType: string | null): boolean {
  if (status !== null) {
    // Key Vault logs a refused sign request with ResultType "Success" and its HTTP status.
    return status < 200 || status >= 300;
  }
  if (resultType !== null) {
    return resultType !== "Success";
  }
  throw new BadResponse("a row has neither an HTTP status nor a result type");
}

/** The fields of a row whose value is set, for `extra` or `extraIds`. */
function present<Value>(fields: Record<string, Value | null>): Record<string, Value> {
  const set: Record<string, Value> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value !== null) {
      set[name] = value;
    }
  }
  return set;
}

/**
 * Maps one row to an event, copying each field as logged.
 *
 * @param cell - Reads a column of the row.
 * @returns The event.
 */
function signEvent(cell: (column: Column) => unknown): KmsHistoryEvent {
  const time = textOf(cell("TimeGenerated"));
  const operation = textOf(cell("OperationName"));
  if (time === null || operation === null) {
    throw new BadResponse("a row has no TimeGenerated or OperationName");
  }
  const status = integerOf(cell("HttpStatusCode"));
  const resultType = textOf(cell("ResultType"));
  const resultSignature = textOf(cell("ResultSignature"));
  const failed = failedOf(status, resultType);
  const id = textOf(cell("Id"));
  const requestUri = textOf(cell("RequestUri"));
  const { principal, identityType, ids } = principalOf(dynamicOf(cell("Identity")));
  const extra: Record<string, KmsHistoryExtraValue> = present({
    resultType,
    resultSignature,
    httpStatusCode: status,
    algorithm: textOf(cell("Algorithm")),
    durationMs: integerOf(cell("DurationMs")),
    operationVersion: textOf(cell("OperationVersion")),
    identityType,
    isRbacAuthorized: booleanOf(cell("IsRbacAuthorized")),
    isAccessPolicyMatch: booleanOf(cell("IsAccessPolicyMatch")),
    tlsVersion: textOf(cell("Tlsversion")),
  });
  const extraIds = present<string>({
    ...ids,
    appliedAssignmentId: textOf(cell("AppliedAssignmentId")),
    subnetId: textOf(cell("SubnetId")),
  });
  return {
    time,
    operation,
    outcome: failed ? "failed" : "success",
    errorCode: failed ? (resultSignature ?? (status === null ? resultType : String(status))) : null,
    errorMessage: failed ? textOf(cell("ResultDescription")) : null,
    principal,
    sourceIp: textOf(cell("CallerIpAddress")),
    userAgent: textOf(cell("ClientInfo")),
    // Checked live: Key Vault logs its own x-ms-request-id as CorrelationId, not the client's id.
    requestId: textOf(cell("CorrelationId")),
    keyVersion: versionOf(id ?? requestUri),
    digest: null,
    keyResource: id ?? requestUri,
    extra,
    ...(Object.keys(extraIds).length === 0 ? {} : { extraIds }),
  };
}

/** The rows of the answer's first table, each read by column name. */
function rowsOf(body: unknown): Array<(column: Column) => unknown> {
  const tables = field(body, "tables");
  const table: unknown = Array.isArray(tables) ? tables.at(0) : undefined;
  const columns = field(table, "columns");
  const rows = field(table, "rows");
  if (!Array.isArray(columns) || !Array.isArray(rows)) {
    throw new BadResponse("the answer has no table with columns and rows");
  }
  const index = new Map<unknown, number>(
    columns.map((column: unknown, position: number) => [field(column, "name"), position]),
  );
  if (!index.has("TimeGenerated") || !index.has("OperationName")) {
    throw new BadResponse("the table has no TimeGenerated or OperationName column");
  }
  return rows.map((row: unknown) => {
    if (!Array.isArray(row)) {
      throw new BadResponse("a row is not a list");
    }
    return (column: Column): unknown => {
      const position = index.get(column);
      return position === undefined ? undefined : row[position];
    };
  });
}

/** The codes of an error answer and its inner errors, outermost first, as far as each is safe. */
function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  for (let inner = error; inner !== undefined && codes.length < 5;) {
    const code = field(inner, "code");
    if (typeof code !== "string" || !SAFE_CODE.test(code)) {
      break;
    }
    codes.push(code);
    inner = field(inner, "innererror");
  }
  return codes;
}

/** The innermost error of an error answer. */
function innermost(error: unknown): unknown {
  let inner = error;
  for (let depth = 0; depth < 5 && field(inner, "innererror") !== undefined; depth++) {
    inner = field(inner, "innererror");
  }
  return inner;
}

/**
 * Whether a 400 answer says the table does not exist. Log Analytics answers an unknown table with
 * the semantic error SEM0100, naming it.
 */
function missingTable(error: unknown): boolean {
  const inner = innermost(error);
  const message = field(inner, "message");
  return (
    field(inner, "code") === "SEM0100" &&
    typeof message === "string" &&
    message.includes(`named '${TABLE}'`)
  );
}

/** Builds a catalogue error with the reader's details. */
type Fail = <Template extends string>(
  entry: ErrorEntry<Template, "error">,
  params: TemplateParams<Template>,
) => Error;

/** The error to throw for an answer with an HTTP error status. */
function explainStatus(
  status: number,
  error: unknown,
  fail: Fail,
  details: { provider: string; operation: string; key: string },
): Error {
  const codes = errorCodes(error);
  const shown = [String(status), ...codes].join(" ");
  if (status === 400 && missingTable(error)) {
    return fail(ERRORS.historyNoTable, {});
  }
  if (status === 401) {
    return fail(ERRORS.historyUnauthorized, { status: shown });
  }
  if (status === 403) {
    return auditLogAccessDenied(READ_PERMISSIONS, details);
  }
  if (status === 404 && codes[0] === "WorkspaceNotFoundError") {
    return fail(ERRORS.historyWorkspaceNotFound, {});
  }
  if (status === 429) {
    return auditLogThrottled(THROTTLE_LIMIT, details);
  }
  return fail(ERRORS.historyReadFailed, { status: shown });
}

/** Error names of @azure/identity when no credential returned a token. */
const NO_CREDENTIAL = new Set(["CredentialUnavailableError", "AggregateAuthenticationError"]);
/** Error names of @azure/identity when a configured credential source could not sign in. */
const FAILED_CREDENTIAL = new Set(["AuthenticationError", "AuthenticationRequiredError"]);

/**
 * Reads a key's sign events from the AZKVAuditLogs table of the workspace set in
 * `kms.audit.azure.workspaceId`: every `KeySign` row on any version of the key in the range,
 * newest first, at most `limit + 1` of them, in one query.
 *
 * Key Vault logs no request content, so `digest` is not logged. The result never claims to see
 * every sign request: the vault needs a diagnostic setting, it may send to other workspaces, and a
 * read without access to the table gets no rows.
 *
 * @param key - The key.
 * @param audit - The resolved `kms.audit` section.
 * @param request - The range, the limit and the signal.
 * @param queryWorkspace - The Log Analytics query call.
 * @returns The result.
 */
export async function readAzureSignHistory(
  key: AzureKmsKeyConfig,
  audit: KmsAuditConfig,
  request: KmsHistoryRequest,
  queryWorkspace: QueryWorkspace,
): Promise<KmsHistoryResult> {
  const signal = request.signal ?? new AbortController().signal;
  const details = { provider: "azure", operation: "history", key: key.displayId };
  const fail: Fail = (entry, params) => catalogError(entry, params, details);

  const target = keyTarget(await key.keyId.get());
  if (target === "key-id") {
    throw fail(ERRORS.historyKeyId, {});
  }
  if (target === "managed-hsm") {
    throw fail(ERRORS.historyManagedHsm, {});
  }
  if (target === "sovereign-cloud") {
    throw fail(ERRORS.historySovereignCloud, {});
  }
  if (audit.azure === undefined) {
    throw fail(ERRORS.historyNoWorkspace, {});
  }
  const workspaceId = (await audit.azure.workspaceId.get()).trim();
  if (!WORKSPACE_ID.test(workspaceId)) {
    throw fail(ERRORS.historyWorkspaceId, {});
  }
  const body: QueryRequest = {
    query: signEventsQuery(target, request.since, request.until, request.limit + 1),
    timespan: `${request.since.toISOString()}/${exclusiveEnd(request.until).toISOString()}`,
  };

  signal.throwIfAborted();
  let answer: QueryAnswer;
  try {
    answer = await queryWorkspace(workspaceId, body, signal);
  } catch (error) {
    signal.throwIfAborted();
    throw explainThrown(error, fail);
  }
  const error = field(answer.body, "error");
  if (answer.status !== 200) {
    throw explainStatus(answer.status, error, fail, details);
  }
  if (error !== undefined) {
    throw fail(ERRORS.historyPartial, { code: errorCodes(error).join(" ") || "no code" });
  }

  const events: KmsHistoryEvent[] = [];
  let rows = 0;
  try {
    for (const cell of rowsOf(answer.body)) {
      rows++;
      const event = signEvent(cell);
      const at = Date.parse(event.time);
      if (!Number.isFinite(at)) {
        throw new BadResponse("a row has a TimeGenerated that is not a date");
      }
      // The query reads the range already; this keeps a row the core would refuse out.
      if (at >= request.since.getTime() && at <= request.until.getTime()) {
        events.push(event);
      }
    }
  } catch (thrown) {
    if (thrown instanceof BadResponse) {
      throw fail(ERRORS.historyBadResponse, { problem: thrown.message });
    }
    throw thrown;
  }

  // One query returns every row up to `limit + 1`: a result is never cut short by a page budget.
  // No `retentionDays`: the workspace's retention is the user's setting.
  return {
    source: SOURCE,
    notLogged: ["digest"],
    events: events.slice(0, request.limit + 1),
    // Truncated by the rows the query returned: `take limit + 1` gave one more than the limit.
    // `limit` needs at least `limit` events; were rows outside the range left out, the read is
    // marked as stopped short instead.
    ...(rows > request.limit
      ? {
          truncated: true,
          truncatedReason:
            events.length >= request.limit ? ("limit" as const) : ("scan-limit" as const),
        }
      : { truncated: false }),
    completeForKey: false,
    scope: { description: SCOPE_DESCRIPTION, ids: { workspace: workspaceId } },
    hiddenValues: [target.host],
    setupHint: SETUP_HINT,
    deliveryDelayMinutes: DELIVERY_DELAY_MINUTES,
  };
}

/** The error to throw for a query that got no answer. */
function explainThrown(error: unknown, fail: Fail): unknown {
  const name = field(error, "name");
  if (typeof name !== "string") {
    return error;
  }
  if (NO_CREDENTIAL.has(name)) {
    return fail(ERRORS.noCredential, { errorName: name });
  }
  if (FAILED_CREDENTIAL.has(name)) {
    return fail(ERRORS.credentialFailed, { errorName: name });
  }
  if (name === "RestError") {
    const code = field(error, "code");
    return fail(ERRORS.historyUnreachable, {
      code: typeof code === "string" && SAFE_CODE.test(code) ? code : "no code",
    });
  }
  return error;
}
