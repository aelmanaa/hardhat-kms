import { setTimeout as delay } from "node:timers/promises";

import {
  auditLogAccessDenied,
  auditLogThrottled,
  catalogError,
  type ErrorDetails,
  parseAwsKeyId,
} from "hardhat-kms/provider-utils";
import type {
  AwsKmsKeyConfig,
  KmsHistoryEvent,
  KmsHistoryExtraValue,
  KmsHistoryNote,
  KmsHistoryRequest,
  KmsHistoryResult,
} from "hardhat-kms/types";

import { ERRORS } from "./error-catalog.ts";
import type { AwsHistoryApi, CloudTrailPage } from "./history-api.ts";

/** The `source` of every AWS history. */
export const HISTORY_SOURCE = "cloudtrail-event-history";

/**
 * How many `LookupEvents` pages one read scans at most: 3,000 `Sign` events of the account and
 * Region. At the pace below plus the time each request takes, that is about 45 to 65 seconds.
 * Past it, the result is truncated by `scan-limit`.
 */
export const MAX_PAGES = 60;

/**
 * How long one read pages for at most, in milliseconds, before it stops with `scan-limit`: well
 * inside the 120 seconds `kms history` waits, even when CloudTrail answers slowly.
 */
export const SCAN_BUDGET_MS = 90_000;

/** CloudTrail allows 2 `LookupEvents` calls per second per account and Region. */
export const PAGE_INTERVAL_MS = 500;

/** The fields CloudTrail never records for a `Sign` call. AWS asymmetric keys have no versions. */
const NOT_LOGGED = ["keyVersion", "digest"] as const;

const KEY_ARN = /^arn:aws(?:-[a-z]+)*:kms:([a-z0-9-]+):(\d{12}):key\/([A-Za-z0-9-]+)$/;
const ACCESS_DENIED = new Set(["AccessDeniedException", "AccessDenied"]);
const THROTTLED = new Set(["ThrottlingException", "Throttling", "TooManyRequestsException"]);

const SETUP_HINT =
  "CloudTrail event history is always on and records every successful sign request, but only in the account of the credentials and the Region read. A request from another account that was refused for access is recorded only in the caller's account. Run kms history with credentials of the key's account, in the key's Region.";

const OTHER_ACCOUNT: KmsHistoryNote = {
  code: "other-account",
  message:
    "The credentials belong to another AWS account than the key. CloudTrail event history shows only the sign requests recorded in that account, so requests made from the key's account or from other accounts are missing.",
};

const OTHER_REGION: KmsHistoryNote = {
  code: "other-region",
  message:
    "The history was read in another Region than the key's. CloudTrail records a sign request in the key's Region, so this read may miss them.",
};

const ACCOUNT_UNKNOWN: KmsHistoryNote = {
  code: "caller-account-unknown",
  message:
    "STS did not tell the account of the credentials, so the reader cannot confirm that they are in the key's account. Sign requests recorded only in other accounts may be missing.",
};

const MULTI_REGION_KEY: KmsHistoryNote = {
  code: "multi-region-key",
  message:
    "This is a multi-Region key. Its replicas sign with the same key material, and CloudTrail records their requests in each replica's Region under the replica's own ARN. Run kms history on each replica's key ARN to see them.",
};

/** The note for events that name no key resource the reader can attribute. */
function unattributedNote(count: number): KmsHistoryNote {
  return {
    code: "unattributed-events",
    message: `${count} Sign event${count === 1 ? "" : "s"} in the range named no key ARN, only an alias the reader cannot tie to this key, so ${count === 1 ? "it is" : "they are"} not listed. Check them in the CloudTrail console.`,
  };
}

/** Waits between pages; tests replace it. */
export type Sleep = (milliseconds: number, signal: AbortSignal | undefined) => Promise<void>;

/** Tests replace the clock and the wait. */
export interface ReaderTiming {
  sleep?: Sleep;
  /** Milliseconds since some fixed point, such as `Date.now`. */
  now?: () => number;
}

const defaultSleep: Sleep = async (milliseconds, signal) => {
  await delay(milliseconds, undefined, signal === undefined ? {} : { signal });
};

/** The error's name, or `undefined` for a value that is not an object with a string name. */
function errorName(error: unknown): string | undefined {
  const name: unknown =
    typeof error === "object" && error !== null ? Reflect.get(error, "name") : undefined;
  return typeof name === "string" ? name : undefined;
}

/** Whether the SDK failed because it found no Region; its message holds no request details. */
function missingRegion(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Region is missing");
}

/** The value as an object, or `undefined` when it is not a non-array object. */
function asObject(value: unknown): object | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

/** A field of a record that is an object, or `undefined`. */
function child(record: object | undefined, name: string): object | undefined {
  return record === undefined ? undefined : asObject(Reflect.get(record, name));
}

/** A string field of a record, or `null` when it is absent, empty or not a string. */
function text(record: object | undefined, name: string): string | null {
  const value: unknown = record === undefined ? undefined : Reflect.get(record, name);
  return typeof value === "string" && value !== "" ? value : null;
}

/** The fields whose value is not `null`. */
function present<Value>(fields: Record<string, Value | null>): Record<string, Value> {
  const kept: Record<string, Value> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value !== null) {
      kept[name] = value;
    }
  }
  return kept;
}

/** How the reader tells this key's events from others'. */
interface KeyMatch {
  /** The key ARN, lowercase. */
  arn: string;
  /** Every id a caller could pass for this key, lowercase: the ARN, the bare id, the alias. */
  ids: ReadonlySet<string>;
}

/** Whether a record is about this key, about another, or cannot tell. */
type Attribution = "key" | "other" | "unknown";

/**
 * Attributes a record to the key by its `resources`, compared without case. A record with no key
 * ARN in its resources falls back to the `keyId` the caller passed: this key's ARN, bare id or
 * configured alias is the key, another key ARN or bare id is another key, and anything else, such
 * as an alias the reader does not know, cannot be told.
 */
function attribute(record: object, match: KeyMatch): Attribution {
  const resources: unknown = Reflect.get(record, "resources");
  const arns = Array.isArray(resources)
    ? resources
        .map((resource: unknown) => text(asObject(resource), "ARN"))
        .filter((arn) => arn !== null)
    : [];
  if (arns.length > 0) {
    return arns.some((arn) => arn.toLowerCase() === match.arn) ? "key" : "other";
  }
  const passed = text(child(record, "requestParameters"), "keyId");
  if (passed === null) {
    return "unknown";
  }
  if (match.ids.has(passed.toLowerCase())) {
    return "key";
  }
  const kind = parseAwsKeyId(passed)?.kind;
  return kind === "keyArn" || kind === "keyId" ? "other" : "unknown";
}

/** A record that is a KMS `Sign` call in the range, or why it is not. */
type Parsed =
  | { kind: "event"; event: KmsHistoryEvent }
  | { kind: "unattributed" }
  | { kind: "skip" };

/**
 * Maps one `CloudTrailEvent` record to a history event when it is a KMS `Sign` call on this key in
 * the range. Every field is copied as logged.
 */
function toEvent(
  raw: string | undefined,
  match: KeyMatch,
  keyArn: string,
  request: KmsHistoryRequest,
  details: ErrorDetails,
): Parsed {
  let parsed: unknown;
  try {
    parsed = raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const record = asObject(parsed);
  if (record === undefined) {
    throw catalogError(ERRORS.historyUnreadableEvent, {}, details);
  }
  if (text(record, "eventSource") !== "kms.amazonaws.com" || text(record, "eventName") !== "Sign") {
    return { kind: "skip" };
  }
  const attribution = attribute(record, match);
  if (attribution === "other") {
    return { kind: "skip" };
  }
  const time = text(record, "eventTime");
  const at = time === null ? Number.NaN : Date.parse(time);
  if (time === null || Number.isNaN(at)) {
    throw catalogError(ERRORS.historyUnreadableEvent, {}, details);
  }
  if (at < request.since.getTime() || at > request.until.getTime()) {
    return { kind: "skip" };
  }
  if (attribution === "unknown") {
    return { kind: "unattributed" };
  }
  const identity = child(record, "userIdentity");
  const session = child(identity, "sessionContext");
  const parameters = child(record, "requestParameters");
  const callerAccount = text(identity, "accountId");
  const recipientAccount = text(record, "recipientAccountId");
  const crossAccount =
    callerAccount === null || recipientAccount === null ? null : callerAccount !== recipientAccount;
  const principal = text(identity, "arn");
  const errorCode = text(record, "errorCode");
  const errorMessage = text(record, "errorMessage");
  const readOnly: unknown = Reflect.get(record, "readOnly");
  const extra = present<KmsHistoryExtraValue>({
    eventId: text(record, "eventID"),
    userIdentityType: text(identity, "type"),
    userName: text(identity, "userName"),
    invokedBy: text(identity, "invokedBy"),
    crossAccount,
    messageType: text(parameters, "messageType"),
    signingAlgorithm: text(parameters, "signingAlgorithm"),
    sharedEventId: text(record, "sharedEventID"),
    tlsVersion: text(child(record, "tlsDetails"), "tlsVersion"),
    readOnly: typeof readOnly === "boolean" ? readOnly : null,
  });
  const extraIds = present<string>({
    accessKeyId: text(identity, "accessKeyId"),
    principalId: text(identity, "principalId"),
    // Without a principal ARN, the caller's account is the one id left that names the caller.
    // Only for another account: the key's own account would then be masked in every principal
    // ARN, and `crossAccount: false` already says the caller was in the key's account.
    callerAccountId: principal === null && crossAccount === true ? callerAccount : null,
    onBehalfOfUserId: text(child(identity, "onBehalfOf"), "userId"),
    sourceIdentity: text(session, "sourceIdentity") ?? text(identity, "sourceIdentity"),
    sessionIssuerArn: text(child(session, "sessionIssuer"), "arn"),
    invokedByDelegateAccountId: text(child(identity, "invokedByDelegate"), "accountId"),
    requestKeyId: text(parameters, "keyId"),
    vpcEndpointId: text(record, "vpcEndpointId"),
  });
  return {
    kind: "event",
    event: {
      time,
      operation: "Sign",
      outcome: errorCode === null && errorMessage === null ? "success" : "failed",
      errorCode,
      errorMessage,
      principal,
      sourceIp: text(record, "sourceIPAddress"),
      userAgent: text(record, "userAgent"),
      requestId: text(record, "requestID"),
      keyVersion: null,
      digest: null,
      keyResource: keyArn,
      extra,
      extraIds,
    },
  };
}

/**
 * Reads one key's sign events from CloudTrail event history.
 *
 * `LookupEvents` indexes an event's resource name as the key id the caller passed: a key ARN, a
 * bare key id or an alias. A lookup by the key ARN would miss the `Sign` calls made with the
 * others. So the reader looks up `Sign` events, pages through them newest first, and keeps those
 * whose record lists the key ARN among its resources, or, without resources, whose `keyId` names
 * the key. It stops at `limit + 1` events, or with `scan-limit` after {@link MAX_PAGES} pages or
 * {@link SCAN_BUDGET_MS}.
 *
 * A key named by an alias or a bare key id is first resolved to its key ARN with `GetPublicKey`,
 * which CloudTrail logs. Such a key is in the account of the credentials. For a key ARN, STS
 * `GetCallerIdentity` tells whether the credentials are in the key's account: CloudTrail event
 * history is kept per account and Region, so only then, in the key's Region, for a key that is
 * not multi-Region and with every event attributed, is the result complete for the key.
 *
 * @param key - The resolved key.
 * @param request - The range, the limit and the signal.
 * @param api - The AWS calls.
 * @param timing - The wait between pages and the clock; tests replace them.
 * @returns The result for the core to check.
 */
export async function readAwsSignHistory(
  key: AwsKmsKeyConfig,
  request: KmsHistoryRequest,
  api: AwsHistoryApi,
  timing: ReaderTiming = {},
): Promise<KmsHistoryResult> {
  const sleep = timing.sleep ?? defaultSleep;
  const now = timing.now ?? Date.now;
  const { signal } = request;
  const details: ErrorDetails = { provider: "aws", operation: "history", key: key.displayId };
  const regionError = (error: unknown): unknown =>
    missingRegion(error) ? catalogError(ERRORS.noRegion, {}, details) : error;

  const keyId = await key.keyId.get();
  const kind = parseAwsKeyId(keyId)?.kind;
  const hiddenValues: string[] = [];
  let keyArn = keyId;
  if (kind !== "keyArn") {
    try {
      keyArn = (await api.resolveKeyArn(keyId, signal)) ?? "";
    } catch (error) {
      const name = errorName(error);
      throw name !== undefined && ACCESS_DENIED.has(name)
        ? catalogError(ERRORS.historyKeyLookupDenied, {}, details)
        : regionError(error);
    }
    hiddenValues.push(keyArn);
  }
  const arn = KEY_ARN.exec(keyArn);
  if (arn?.[1] === undefined || arn[2] === undefined || arn[3] === undefined) {
    throw catalogError(ERRORS.noKeyArn, {}, details);
  }
  const [, keyRegion, keyAccount, bareKeyId] = arn;
  const match: KeyMatch = {
    arn: keyArn.toLowerCase(),
    ids: new Set([keyArn, bareKeyId, keyId].map((id) => id.toLowerCase())),
  };

  let region: string;
  try {
    region = await api.region();
  } catch (error) {
    throw regionError(error);
  }
  // An alias or a bare key id names a key of the credentials' own account. For a key ARN, a
  // failed STS call leaves the account unknown, and the result incomplete, rather than failing.
  let account: string | undefined = keyAccount;
  if (kind === "keyArn") {
    try {
      account = await api.callerAccount(signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (missingRegion(error)) {
        throw regionError(error);
      }
      account = undefined;
    }
  }

  const events: KmsHistoryEvent[] = [];
  let unattributed = 0;
  // CloudTrail times are whole seconds; the end is widened by one so `until` is surely included.
  const range = { start: request.since, end: new Date(request.until.getTime() + 1000) };
  const started = now();
  let nextToken: string | undefined;
  let pages = 0;
  let scanStopped = false;
  for (;;) {
    signal?.throwIfAborted();
    if (pages > 0) {
      await sleep(PAGE_INTERVAL_MS, signal);
    }
    let page: CloudTrailPage;
    try {
      page = await api.lookupSignEvents(range, nextToken, signal);
    } catch (error) {
      const name = errorName(error);
      if (name !== undefined && ACCESS_DENIED.has(name)) {
        throw auditLogAccessDenied("cloudtrail:LookupEvents", details);
      }
      if (name !== undefined && THROTTLED.has(name)) {
        throw auditLogThrottled("2 requests per second", details);
      }
      throw regionError(error);
    }
    pages += 1;
    for (const raw of page.events) {
      const parsed = toEvent(raw, match, keyArn, request, details);
      if (parsed.kind === "event") {
        events.push(parsed.event);
      } else if (parsed.kind === "unattributed") {
        unattributed += 1;
      }
      if (events.length > request.limit) {
        break;
      }
    }
    nextToken = page.nextToken;
    if (events.length > request.limit || nextToken === undefined) {
      break;
    }
    if (pages >= MAX_PAGES || now() - started >= SCAN_BUDGET_MS) {
      scanStopped = true;
      break;
    }
  }

  const notes: KmsHistoryNote[] = [
    ...(account === undefined ? [ACCOUNT_UNKNOWN] : account === keyAccount ? [] : [OTHER_ACCOUNT]),
    ...(region === keyRegion ? [] : [OTHER_REGION]),
    ...(bareKeyId.startsWith("mrk-") ? [MULTI_REGION_KEY] : []),
    ...(unattributed === 0 ? [] : [unattributedNote(unattributed)]),
  ];
  const truncation =
    events.length > request.limit
      ? { truncated: true, truncatedReason: "limit" as const }
      : scanStopped
        ? { truncated: true, truncatedReason: "scan-limit" as const }
        : { truncated: false };
  return {
    source: HISTORY_SOURCE,
    notLogged: NOT_LOGGED,
    events,
    ...truncation,
    completeForKey: notes.length === 0,
    scope: {
      description: region,
      ...(account === undefined ? {} : { ids: { account } }),
    },
    hiddenValues,
    setupHint: SETUP_HINT,
    deliveryDelayMinutes: 5,
    retentionDays: 90,
    notes,
  };
}
