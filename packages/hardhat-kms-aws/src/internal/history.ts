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
 * Region, about 30 seconds at the pace below, well inside the 120 seconds `kms history` waits.
 * Past it, the result is truncated by `scan-limit`.
 */
export const MAX_PAGES = 60;

/** CloudTrail allows 2 `LookupEvents` calls per second per account and Region. */
export const PAGE_INTERVAL_MS = 500;

/** The fields CloudTrail never records for a `Sign` call. AWS asymmetric keys have no versions. */
const NOT_LOGGED = ["keyVersion", "digest"] as const;

const KEY_ARN = /^arn:aws(?:-[a-z]+)*:kms:([a-z0-9-]+):(\d{12}):key\/[A-Za-z0-9-]+$/;
const ACCESS_DENIED = new Set(["AccessDeniedException", "AccessDenied"]);
const THROTTLED = new Set(["ThrottlingException", "Throttling", "TooManyRequestsException"]);

const SETUP_HINT =
  "CloudTrail event history is always on, but it holds only the requests recorded in the account of the credentials and in the Region read. Run kms history with credentials of the key's account to see every sign request on the key.";

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

/** Waits between pages; tests replace it. */
export type Sleep = (milliseconds: number, signal: AbortSignal | undefined) => Promise<void>;

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

/** Whether a CloudTrail record lists the key ARN among its resources. */
function namesKey(record: object, keyArn: string): boolean {
  const resources: unknown = Reflect.get(record, "resources");
  return (
    Array.isArray(resources) &&
    resources.some((resource: unknown) => text(asObject(resource), "ARN") === keyArn)
  );
}

/**
 * Maps one `CloudTrailEvent` record to a history event, or `undefined` when it is not a KMS `Sign`
 * call on this key in the range. Every field is copied as logged.
 */
function toEvent(
  raw: string | undefined,
  keyArn: string,
  request: KmsHistoryRequest,
  details: ErrorDetails,
): KmsHistoryEvent | undefined {
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
  if (
    text(record, "eventSource") !== "kms.amazonaws.com" ||
    text(record, "eventName") !== "Sign" ||
    !namesKey(record, keyArn)
  ) {
    return undefined;
  }
  const time = text(record, "eventTime");
  const at = time === null ? Number.NaN : Date.parse(time);
  if (time === null || Number.isNaN(at)) {
    throw catalogError(ERRORS.historyUnreadableEvent, {}, details);
  }
  if (at < request.since.getTime() || at > request.until.getTime()) {
    return undefined;
  }
  const identity = asObject(Reflect.get(record, "userIdentity"));
  const parameters = asObject(Reflect.get(record, "requestParameters"));
  const tls = asObject(Reflect.get(record, "tlsDetails"));
  const errorCode = text(record, "errorCode");
  const errorMessage = text(record, "errorMessage");
  const readOnly: unknown = Reflect.get(record, "readOnly");
  const extra = present<KmsHistoryExtraValue>({
    eventId: text(record, "eventID"),
    userIdentityType: text(identity, "type"),
    userName: text(identity, "userName"),
    invokedBy: text(identity, "invokedBy"),
    messageType: text(parameters, "messageType"),
    signingAlgorithm: text(parameters, "signingAlgorithm"),
    sharedEventId: text(record, "sharedEventID"),
    tlsVersion: text(tls, "tlsVersion"),
    readOnly: typeof readOnly === "boolean" ? readOnly : null,
  });
  // Account ids are left out: the principal ARN shows the caller's, and `scope` the reader's.
  const extraIds = present<string>({
    accessKeyId: text(identity, "accessKeyId"),
    principalId: text(identity, "principalId"),
    requestKeyId: text(parameters, "keyId"),
    vpcEndpointId: text(record, "vpcEndpointId"),
  });
  return {
    time,
    operation: "Sign",
    outcome: errorCode === null && errorMessage === null ? "success" : "failed",
    errorCode,
    errorMessage,
    principal: text(identity, "arn"),
    sourceIp: text(record, "sourceIPAddress"),
    userAgent: text(record, "userAgent"),
    requestId: text(record, "requestID"),
    keyVersion: null,
    digest: null,
    keyResource: keyArn,
    extra,
    extraIds,
  };
}

/**
 * Reads one key's sign events from CloudTrail event history.
 *
 * `LookupEvents` indexes an event's resource name as the key id the caller passed: a key ARN, a
 * bare key id or an alias. A lookup by the key ARN would miss the `Sign` calls made with the
 * others. So the reader looks up `Sign` events, pages through them newest first, and keeps those
 * whose record lists the key ARN among its resources. It stops at `limit + 1` events, or after
 * {@link MAX_PAGES} pages with the result truncated by `scan-limit`.
 *
 * A key named by an alias or a bare key id is first resolved to its key ARN with `GetPublicKey`,
 * which CloudTrail logs. Such a key is in the account of the credentials. For a key ARN, STS
 * `GetCallerIdentity` tells whether the credentials are in the key's account: CloudTrail event
 * history is kept per account and Region, so only then, and in the key's Region, does the read
 * see every sign request on the key.
 *
 * @param key - The resolved key.
 * @param request - The range, the limit and the signal.
 * @param api - The AWS calls.
 * @param sleep - Waits between pages.
 * @returns The result for the core to check.
 */
export async function readAwsSignHistory(
  key: AwsKmsKeyConfig,
  request: KmsHistoryRequest,
  api: AwsHistoryApi,
  sleep: Sleep = defaultSleep,
): Promise<KmsHistoryResult> {
  const { signal } = request;
  const details: ErrorDetails = { provider: "aws", operation: "history", key: key.displayId };
  // Sorts an SDK error: a refusal names the permission `denied` gives, and CloudTrail throttling
  // the lookup limit. Other errors pass through for the core to reduce to their class name.
  const sorted = async <Value>(
    call: () => Promise<Value>,
    denied: () => Error,
    lookup = false,
  ): Promise<Value> => {
    try {
      return await call();
    } catch (error) {
      const name = errorName(error);
      if (name !== undefined && ACCESS_DENIED.has(name)) {
        throw denied();
      }
      if (lookup && name !== undefined && THROTTLED.has(name)) {
        throw auditLogThrottled("2 requests per second", details);
      }
      if (missingRegion(error)) {
        throw catalogError(ERRORS.noRegion, {}, details);
      }
      throw error;
    }
  };
  const lookupDenied = (): Error => auditLogAccessDenied("cloudtrail:LookupEvents", details);

  const keyId = await key.keyId.get();
  const kind = parseAwsKeyId(keyId)?.kind;
  const hiddenValues: string[] = [];
  let keyArn = keyId;
  if (kind !== "keyArn") {
    const resolved = await sorted(
      async () => await api.resolveKeyArn(keyId, signal),
      () => catalogError(ERRORS.historyKeyLookupDenied, {}, details),
    );
    keyArn = resolved ?? "";
    hiddenValues.push(keyArn);
  }
  const arn = KEY_ARN.exec(keyArn);
  if (arn?.[1] === undefined || arn[2] === undefined) {
    throw catalogError(ERRORS.noKeyArn, {}, details);
  }
  const [, keyRegion, keyAccount] = arn;
  // An alias or a bare key id names a key of the credentials' own account.
  const account =
    kind === "keyArn"
      ? await sorted(
          async () => await api.callerAccount(signal),
          () => auditLogAccessDenied("sts:GetCallerIdentity", details),
        )
      : keyAccount;
  const region = await sorted(async () => await api.region(), lookupDenied);
  const notes: KmsHistoryNote[] = [
    ...(account === keyAccount ? [] : [OTHER_ACCOUNT]),
    ...(region === keyRegion ? [] : [OTHER_REGION]),
  ];

  const events: KmsHistoryEvent[] = [];
  // CloudTrail times are whole seconds; the end is widened by one so `until` is surely included.
  const range = { start: request.since, end: new Date(request.until.getTime() + 1000) };
  let nextToken: string | undefined;
  let pages = 0;
  let scanStopped = false;
  for (;;) {
    signal?.throwIfAborted();
    if (pages > 0) {
      await sleep(PAGE_INTERVAL_MS, signal);
    }
    const token = nextToken;
    const page: CloudTrailPage = await sorted(
      async () => await api.lookupSignEvents(range, token, signal),
      lookupDenied,
      true,
    );
    pages += 1;
    for (const raw of page.events) {
      const event = toEvent(raw, keyArn, request, details);
      if (event !== undefined) {
        events.push(event);
      }
      if (events.length > request.limit) {
        break;
      }
    }
    nextToken = page.nextToken;
    if (events.length > request.limit || nextToken === undefined) {
      break;
    }
    if (pages >= MAX_PAGES) {
      scanStopped = true;
      break;
    }
  }

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
