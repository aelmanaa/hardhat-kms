// The Google Cloud reader of `kms history`: lists a key's AsymmetricSign entries from the Data
// Access audit log of its project, through Cloud Logging's `entries.list`. It takes the call as an
// argument, so tests pass a fake; logging-client.ts makes the real one.
import {
  auditLogAccessDenied,
  auditLogThrottled,
  catalogError,
  type ErrorEntry,
  type TemplateParams,
} from "hardhat-kms/provider-utils";
import type {
  GcpKmsKeyConfig,
  KmsHistoryEvent,
  KmsHistoryExtraValue,
  KmsHistoryNote,
  KmsHistoryRequest,
  KmsHistoryResult,
} from "hardhat-kms/types";

import { ERRORS } from "./error-catalog.ts";
import { credentialFailure, statusName } from "./wire.ts";

/** The body of an `entries.list` request. */
export interface ListEntriesRequest {
  resourceNames: string[];
  filter: string;
  orderBy: "timestamp desc";
  pageSize: number;
  pageToken?: string;
}

/**
 * One `entries.list` call: sends the request and returns the parsed JSON answer. It rejects with
 * the HTTP client's error, which carries the HTTP status, stops when `signal` aborts, and rejects
 * with {@link CallTimedOut} when no answer came within `timeoutMs`.
 */
export type ListEntries = (
  request: ListEntriesRequest,
  signal: AbortSignal,
  timeoutMs: number,
) => Promise<unknown>;

/** The error an `entries.list` call rejects with when Cloud Logging does not answer in time. */
export class CallTimedOut extends Error {
  public override readonly name = "CallTimedOut";
  public readonly seconds: number;

  /** @param ms - The time the call had, in milliseconds. */
  public constructor(ms: number) {
    super(`no answer within ${ms} ms`);
    this.seconds = Math.round(ms / 1000);
  }
}

/** What the reader can be given instead of the real clock and timers, for tests. */
export interface ReaderOptions {
  /** Waits before a retry, or less if `signal` aborts. */
  pause?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The current time, in milliseconds since the epoch: for the scan budget and the notes. */
  now?: () => number;
}

/** The `source` of every result. */
const SOURCE = "cloud-logging";

/**
 * The most pages one read asks for: 10 pages, up to 30 `entries.list` calls with retries. Cloud
 * Logging allows 60 calls a minute per project, and a page can come back empty with a token for
 * the next one when the range is long, so the reader stops here and says the range was not read
 * in full.
 */
export const PAGE_BUDGET = 10;

/**
 * How long one read asks for pages at most, in milliseconds, before it stops with `scan-limit`:
 * well inside the 120 seconds `kms history` waits. Checked before each page and each retry.
 */
export const SCAN_BUDGET_MS = 90_000;

/** How long one call may take, in milliseconds, or less when the scan budget has less left. */
export const CALL_TIMEOUT_MS = 30_000;

/** The largest `pageSize` that `entries.list` takes. */
export const MAX_PAGE_SIZE = 1000;

/**
 * The pauses before repeating a throttled, failed or unreachable call: two retries. A 429 comes
 * from a per-minute quota, which these pauses rarely outlast; they help with a short burst only.
 */
export const RETRY_DELAYS_MS: readonly number[] = [1000, 2000];

/**
 * How many times a call that got no answer in time is repeated. Once: `entries.list` is a read, so
 * repeating it is safe, and a stalled connection shows up only as a timeout and is gone on a new
 * one. A second timeout means the query itself is slow, and a third try would spend the budget.
 */
const TIMEOUT_RETRIES = 1;

/**
 * How many days the `_Default` bucket keeps Data Access entries unless its retention was changed.
 * Not given to the core as `retentionDays`, which is for a retention the user cannot change; the
 * reader adds its own note instead.
 */
const DEFAULT_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Cloud Logging quota that throttled reads hit. */
const THROTTLE_LIMIT = "60 per minute";

/** The permission, and the role that holds it, that reading Data Access entries needs. */
const READ_PERMISSION = "logging.privateLogEntries.list (roles/logging.privateLogViewer)";

const SETUP_HINT =
  "Check that Data Access audit logs (DATA_READ) are on for Cloud KMS (cloudkms.googleapis.com) in the key's project, that the signing identity is not an exempted principal, and that no exclusion filter or sink keeps the entries out of the _Default bucket.";

const SCOPE_DESCRIPTION = "Data Access audit log, every version of the key";

/** The statuses worth a retry: throttled, or a server that may answer next time. */
const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/**
 * A part of a key version name, as the config check takes it. None of these characters means
 * anything inside a quoted Cloud Logging string, so a part cannot change the query.
 */
const PART = String.raw`[A-Za-z0-9_.:-]+`;
const KEY_VERSION_NAME = new RegExp(
  `^projects/(${PART})/locations/(${PART})/keyRings/(${PART})/cryptoKeys/(${PART})/cryptoKeyVersions/[1-9]\\d*$`,
);
const VERSION = /^[1-9]\d*$/;
/** `projects/<p>/`, the start of a resource name. */
const PROJECT_PREFIX = /^projects\/[^/]+\//;
const HEX_DIGEST = /^[0-9a-fA-F]{64}$/;
const BASE64_DIGEST = /^[A-Za-z0-9+/]{43}=$/;
const SUBJECT_TYPE = /^[A-Za-z]+$/;
const STATUS_TEXT = /^[A-Z][A-Z_]{0,63}$/;
// A Node errno code, such as ECONNRESET, and not one of Node's own ERR_* codes.
const ERRNO = /^E(?!RR_)[A-Z0-9_]{2,31}$/;

/** The parts of a key's name the query is built from. */
interface KeyParts {
  project: string;
  location: string;
  keyRing: string;
  key: string;
  /**
   * `locations/<l>/keyRings/<r>/cryptoKeys/<k>`: the key without its project and version. The
   * project can be configured by its id or its number, and a log entry may name it either way.
   */
  keyPath: string;
}

/**
 * Splits a key version name into its checked parts.
 *
 * @param name - The key version name.
 * @returns The parts, or `undefined` when a part has a character outside the config check's set.
 */
export function keyParts(name: string): KeyParts | undefined {
  const match = KEY_VERSION_NAME.exec(name);
  if (match === null) {
    return undefined;
  }
  const [, project = "", location = "", keyRing = "", key = ""] = match;
  if ([project, location, keyRing, key].some((part) => part === "." || part === "..")) {
    return undefined;
  }
  return {
    project,
    location,
    keyRing,
    key,
    keyPath: `locations/${location}/keyRings/${keyRing}/cryptoKeys/${key}`,
  };
}

/**
 * Quotes a value for a Cloud Logging filter: a double-quoted string with `\` and `"` escaped.
 *
 * @param value - The value.
 * @returns The quoted string.
 */
export function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * The Cloud Logging filter for a key's sign entries in a range. Cloud Logging compares these
 * strings without regard to case, so the reader checks each entry's `resourceName` exactly too.
 * No clause names the project, which the config may give by its id or its number: the request's
 * `resourceNames` reads the project's own logs only.
 *
 * @param parts - The key's parts.
 * @param since - The start of the range, inclusive.
 * @param until - The end of the range, inclusive, on a whole second.
 * @returns The filter.
 */
export function signEntriesFilter(parts: KeyParts, since: Date, until: Date): string {
  // `until` is inclusive and entries carry fractions of a second: ask for the whole second.
  const end = new Date(until.getTime() + 1000);
  return [
    `log_id("cloudaudit.googleapis.com/data_access")`,
    `resource.type="cloudkms_cryptokeyversion"`,
    `resource.labels.location=${quote(parts.location)}`,
    `resource.labels.key_ring_id=${quote(parts.keyRing)}`,
    `resource.labels.crypto_key_id=${quote(parts.key)}`,
    `protoPayload.methodName="AsymmetricSign"`,
    // Every version of the key, even when the config pins one.
    `protoPayload.resourceName:${quote(`/${parts.keyPath}/cryptoKeyVersions/`)}`,
    `timestamp>=${quote(since.toISOString())}`,
    `timestamp<${quote(end.toISOString())}`,
  ].join(" AND ");
}

/** Reads a property of a value that may not be an object. */
function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

/** A field that is a non-empty string, or `null`. */
function text(value: unknown, name: string): string | null {
  const item = field(value, name);
  return typeof item === "string" && item !== "" ? item : null;
}

/**
 * The digest of a sign entry as `0x`-prefixed lowercase hex. Cloud Audit Logs writes it as 64 hex
 * characters; the base64 of protobuf's JSON mapping is read too, since both name the same bytes.
 *
 * @param value - `protoPayload.request.digest.sha256`.
 * @returns The digest, or `null` when the entry holds none in either form.
 */
export function digestHex(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  if (HEX_DIGEST.test(value)) {
    return `0x${value.toLowerCase()}`;
  }
  if (BASE64_DIGEST.test(value)) {
    return `0x${Buffer.from(value, "base64").toString("hex")}`;
  }
  return null;
}

/** Whether a principal subject is `<type>:` followed by the principal's email. */
function repeatsEmail(subject: string | null, email: string | null): boolean {
  return (
    subject !== null &&
    email !== null &&
    subject.endsWith(`:${email}`) &&
    SUBJECT_TYPE.test(subject.slice(0, -(email.length + 1)))
  );
}

/** Why an answer could not be read; the text is the reader's own, with no value from the answer. */
class BadResponse extends Error {
  public override readonly name = "BadResponse";
}

/** The scan budget ran out: the reader stops and returns what it read. */
class ScanBudgetSpent extends Error {
  public override readonly name = "ScanBudgetSpent";
}

/**
 * Maps one `AsymmetricSign` entry of the key to an event, copying each field as logged.
 *
 * @param entry - The log entry.
 * @param parts - The key's parts.
 * @param range - The range, to leave out an entry outside it.
 * @returns The event, or `undefined` for an entry of another key or outside the range.
 */
function signEvent(
  entry: unknown,
  parts: KeyParts,
  range: { since: Date; until: Date },
): KmsHistoryEvent | undefined {
  const payload = field(entry, "protoPayload");
  const resourceName = text(payload, "resourceName");
  const operation = text(payload, "methodName");
  const time = text(entry, "timestamp");
  if (payload === undefined || resourceName === null || operation === null || time === null) {
    throw new BadResponse("an entry has no protoPayload, resourceName, methodName or timestamp");
  }
  // The filter matches without regard to case: an entry of a key whose name differs only in case
  // belongs to another key. The project part is not compared, since it can be the id or the
  // number; the request reads the key's project only.
  const suffix = `/${parts.keyPath}/cryptoKeyVersions/`;
  const project = PROJECT_PREFIX.exec(resourceName)?.[0];
  const version =
    project !== undefined && resourceName.startsWith(suffix, project.length - 1)
      ? resourceName.slice(project.length - 1 + suffix.length)
      : "";
  if (!VERSION.test(version) || operation !== "AsymmetricSign") {
    return undefined;
  }
  const at = Date.parse(time);
  if (!Number.isFinite(at)) {
    throw new BadResponse("an entry has a timestamp that is not a date");
  }
  if (at < range.since.getTime() || at > range.until.getTime()) {
    return undefined;
  }
  const status = field(payload, "status");
  const code = field(status, "code");
  const statusCode = typeof code === "number" && Number.isInteger(code) ? code : null;
  const errorMessage = text(status, "message");
  // A served request is logged with `status: {}`; a refused one with a code and a message.
  const failed = (statusCode !== null && statusCode !== 0) || errorMessage !== null;
  const authentication = field(payload, "authenticationInfo");
  const metadata = field(payload, "requestMetadata");
  const principalEmail = text(authentication, "principalEmail");
  const principalSubject = text(authentication, "principalSubject");
  const oauthClientId = text(field(authentication, "oauthInfo"), "oauthClientId");
  const extra: Record<string, KmsHistoryExtraValue> = {
    insertId: text(entry, "insertId"),
    // Left out when it only repeats the email, as `user:<email>` or `serviceAccount:<email>`.
    ...(repeatsEmail(principalSubject, principalEmail) ? {} : { principalSubject }),
    receiveTimestamp: text(entry, "receiveTimestamp"),
    statusCode,
  };
  return {
    time,
    operation,
    outcome: failed ? "failed" : "success",
    errorCode:
      failed && statusCode !== null ? (statusName(statusCode) ?? String(statusCode)) : null,
    errorMessage: failed ? errorMessage : null,
    principal: principalEmail ?? principalSubject,
    sourceIp: text(metadata, "callerIp"),
    userAgent: text(metadata, "callerSuppliedUserAgent"),
    requestId: null,
    keyVersion: version,
    digest: digestHex(field(field(field(payload, "request"), "digest"), "sha256")),
    keyResource: resourceName,
    extra,
    // The OAuth client of user credentials identifies a credential: shown only with --show-ids.
    ...(oauthClientId === null ? {} : { extraIds: { oauthClientId } }),
  };
}

/** The entries and the next page token of an `entries.list` answer. */
function page(answer: unknown): { entries: unknown[]; nextPageToken: string | null } {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    throw new BadResponse("the answer is not an object");
  }
  const entries = field(answer, "entries") ?? [];
  if (!Array.isArray(entries)) {
    throw new BadResponse("entries is not a list");
  }
  const token = field(answer, "nextPageToken");
  if (token !== undefined && typeof token !== "string") {
    throw new BadResponse("nextPageToken is not a string");
  }
  return { entries, nextPageToken: token === undefined || token === "" ? null : token };
}

/** The HTTP status of a failed call, from gaxios's error or its response. */
function httpStatus(error: unknown): number | undefined {
  const status = field(error, "status") ?? field(field(error, "response"), "status");
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

/** The `error` object of a Google API error answer. */
function apiError(error: unknown): unknown {
  return field(field(field(error, "response"), "data"), "error");
}

/** The status name of a Google API error answer, such as `PERMISSION_DENIED`, if well formed. */
function apiStatus(error: unknown): string | undefined {
  const status = field(apiError(error), "status");
  return typeof status === "string" && STATUS_TEXT.test(status) ? status : undefined;
}

/** Whether a Google API error answer gives `SERVICE_DISABLED` as its reason. */
function serviceDisabled(error: unknown): boolean {
  const details = field(apiError(error), "details");
  return (
    Array.isArray(details) &&
    details.some((detail: unknown) => field(detail, "reason") === "SERVICE_DISABLED")
  );
}

/** The errno code of a request that never got an answer, such as `ECONNREFUSED`. */
function networkCode(error: unknown): string | undefined {
  for (const code of [field(error, "code"), field(field(error, "cause"), "code")]) {
    // Only the shape of a Node errno code, so nothing else from the error can be shown.
    if (typeof code === "string" && ERRNO.test(code)) {
      return code;
    }
  }
  return undefined;
}

/** Waits `ms` milliseconds, or less if `signal` aborts. */
async function systemPause(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Reads a key's sign events from the Data Access audit log of its project: every
 * `AsymmetricSign` entry on any version of the key in the range, newest first, at most
 * `limit + 1` of them.
 *
 * It stops with `scan-limit` after {@link PAGE_BUDGET} pages or {@link SCAN_BUDGET_MS}, and keeps
 * what it read.
 *
 * Cloud Audit Logs logs no request id, so `requestId` is not logged and each entry's `insertId`
 * goes in `extra`. The result never claims to see every sign request: Data Access logs can be
 * off, a principal can be exempted, and an exclusion filter or a sink can keep entries out.
 *
 * @param key - The key.
 * @param request - The range, the limit and the signal.
 * @param listEntries - The `entries.list` call.
 * @param options - Replaces the clock and the timers, for tests.
 * @returns The result.
 */
export async function readGcpSignHistory(
  key: GcpKmsKeyConfig,
  request: KmsHistoryRequest,
  listEntries: ListEntries,
  options: ReaderOptions = {},
): Promise<KmsHistoryResult> {
  const pause = options.pause ?? systemPause;
  const now = options.now ?? Date.now;
  const signal = request.signal ?? new AbortController().signal;
  const details = { provider: "gcp", operation: "history", key: key.displayId };
  const fail = <Template extends string>(
    entry: ErrorEntry<Template, "error">,
    params: TemplateParams<Template>,
  ): Error => catalogError(entry, params, details);

  const parts = keyParts(await key.keyVersionName.get());
  if (parts === undefined) {
    throw fail(ERRORS.historyKeyName, {});
  }
  const body: ListEntriesRequest = {
    resourceNames: [`projects/${parts.project}`],
    filter: signEntriesFilter(parts, request.since, request.until),
    orderBy: "timestamp desc",
    pageSize: Math.min(request.limit + 1, MAX_PAGE_SIZE),
  };

  const started = now();
  /** What is left of the scan budget, in milliseconds. */
  const budgetLeft = (): number => SCAN_BUDGET_MS - (now() - started);

  /**
   * One page, with retries on throttling, server errors, network errors and one timeout. Rejects
   * with {@link ScanBudgetSpent} when the budget runs out before a call or a retry, or cuts a
   * call short.
   */
  const call = async (pageToken: string | null): Promise<unknown> => {
    let timeouts = 0;
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const left = budgetLeft();
      if (left <= 0) {
        throw new ScanBudgetSpent();
      }
      const callMs = Math.min(CALL_TIMEOUT_MS, left);
      try {
        return await listEntries(
          pageToken === null ? body : { ...body, pageToken },
          signal,
          callMs,
        );
      } catch (error) {
        signal.throwIfAborted();
        const timedOut = error instanceof CallTimedOut;
        // A call cut short by the budget's end, not by its own 30 seconds: the budget is spent.
        if (timedOut && (callMs < CALL_TIMEOUT_MS || budgetLeft() <= 0)) {
          throw new ScanBudgetSpent();
        }
        timeouts += timedOut ? 1 : 0;
        const status = httpStatus(error);
        // A credentials file that cannot be read fails with its file system code, such as
        // ENOENT: that is not a network error, and a retry would not fix it.
        const code =
          status === undefined && credentialFailure(error) === undefined
            ? networkCode(error)
            : undefined;
        const delay = RETRY_DELAYS_MS[attempt];
        const retryable = timedOut
          ? timeouts <= TIMEOUT_RETRIES
          : status === undefined
            ? code !== undefined
            : RETRY_STATUSES.has(status);
        if (retryable && delay !== undefined) {
          if (budgetLeft() <= delay) {
            throw new ScanBudgetSpent();
          }
          await pause(delay, signal);
          continue;
        }
        throw classify(error, status, code, attempt + 1);
      }
    }
  };

  /** The error to throw for a call that failed for good. */
  const classify = (
    error: unknown,
    status: number | undefined,
    code: string | undefined,
    attempts: number,
  ): unknown => {
    if (status === 401) {
      return fail(ERRORS.unauthenticated, {});
    }
    if (status === 403) {
      return serviceDisabled(error)
        ? fail(ERRORS.historyApiDisabled, {})
        : auditLogAccessDenied(READ_PERMISSION, details);
    }
    if (status === 429) {
      return auditLogThrottled(THROTTLE_LIMIT, details);
    }
    if (status !== undefined) {
      const name = apiStatus(error);
      return fail(ERRORS.historyReadFailed, {
        status: name === undefined ? String(status) : `${status} ${name}`,
      });
    }
    if (code !== undefined) {
      return fail(ERRORS.historyUnreachable, { code, attempts });
    }
    if (error instanceof CallTimedOut) {
      return fail(ERRORS.historyCallTimedOut, { seconds: error.seconds, attempts });
    }
    const credentials = credentialFailure(error);
    if (credentials !== undefined) {
      return fail(ERRORS[credentials], {});
    }
    return error;
  };

  const events: KmsHistoryEvent[] = [];
  let pageToken: string | null = null;
  let pages = 0;
  let scanStopped = false;
  try {
    for (;;) {
      const answer = page(await call(pageToken));
      pages++;
      for (const entry of answer.entries) {
        const event = signEvent(entry, parts, request);
        if (event !== undefined) {
          events.push(event);
        }
      }
      pageToken = answer.nextPageToken;
      if (pageToken === null || events.length > request.limit) {
        break;
      }
      if (pages >= PAGE_BUDGET) {
        scanStopped = true;
        break;
      }
    }
  } catch (error) {
    if (error instanceof ScanBudgetSpent) {
      // The pages read so far are kept; the result says the range was not read in full.
      scanStopped = true;
    } else if (error instanceof BadResponse) {
      throw fail(ERRORS.historyBadResponse, { problem: error.message });
    } else {
      throw error;
    }
  }

  const notes: KmsHistoryNote[] = [];
  if (request.since.getTime() < now() - DEFAULT_RETENTION_DAYS * DAY_MS) {
    notes.push({
      code: "default-retention",
      message: `Cloud Logging keeps Data Access audit log entries for ${DEFAULT_RETENTION_DAYS} days in the _Default bucket, unless its retention was changed, so this range may start before the oldest entry.`,
    });
  }
  const overLimit = events.length > request.limit;
  // No `deliveryDelayMinutes`: Google documents no delivery delay for audit logs (entries took
  // under 2 seconds in the live test), and the core would print the figure as documented. No
  // `retentionDays` either, since a bucket's retention can be changed; the note above says so.
  return {
    source: SOURCE,
    notLogged: ["requestId"],
    events: events.slice(0, request.limit + 1),
    ...(overLimit
      ? { truncated: true, truncatedReason: "limit" as const }
      : scanStopped
        ? { truncated: true, truncatedReason: "scan-limit" as const }
        : { truncated: false }),
    completeForKey: false,
    scope: { description: SCOPE_DESCRIPTION, ids: { project: parts.project } },
    setupHint: SETUP_HINT,
    notes,
  };
}
