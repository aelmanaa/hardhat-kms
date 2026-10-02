import type { KmsKeyConfig } from "../../types.ts";

/**
 * A field of a sign event that a provider may not record. A reader lists the fields its
 * provider never logs in {@link KmsHistoryResult.notLogged}, and sets them to `null` in every
 * event.
 *
 * @experimental May gain members before 1.0.
 */
export type KmsHistoryField =
  | "principal"
  | "sourceIp"
  | "userAgent"
  | "requestId"
  | "keyVersion"
  | "digest";

/** A value a reader may put in {@link KmsHistoryEvent.extra}. */
export type KmsHistoryExtraValue = string | number | boolean | null;

/**
 * What `kms history` asks a reader for: the sign events of one key in a time range, newest first.
 *
 * @experimental May gain optional fields before 1.0.
 */
export interface KmsHistoryRequest {
  /** The resolved key, as `kms.createKeyAdapter` receives it. */
  key: KmsKeyConfig;
  /** The start of the range, inclusive. */
  since: Date;
  /** The end of the range, inclusive. Never before `since`. */
  until: Date;
  /**
   * Return at most this many events, the newest ones. When the log holds more in the range, set
   * `truncated` in the result. An integer from 1 to 1000.
   */
  limit: number;
}

/**
 * One sign event as the provider's audit log records it. Every field is copied from the log
 * entry, with no value guessed or filled in. A field the provider records but left empty in this
 * entry is `null`, and so is a field listed in {@link KmsHistoryResult.notLogged}.
 *
 * `kms history` prints `principal`, `sourceIp`, `userAgent`, `requestId`, `keyVersion`, `digest`
 * and `extra` as they are, and the error code. It shows `keyResource`, `errorMessage` and
 * `extraIds` only with `--show-ids`, and by default replaces any of their values found in other
 * fields with the key's display id.
 *
 * @experimental May gain optional fields before 1.0.
 */
export interface KmsHistoryEvent {
  /** When the provider logged the request, as an ISO 8601 time with a time zone. */
  time: string;
  /** The provider's name for the operation, such as `Sign`, `AsymmetricSign` or `KeySign`. */
  operation: string;
  /** Whether the provider reports the request as served or refused. */
  outcome: "success" | "failed";
  /** The provider's error code for a failed request, such as `AccessDeniedException`. */
  errorCode: string | null;
  /** The provider's error message. It can name accounts, projects and keys. */
  errorMessage: string | null;
  /** Who made the request: an ARN, an email address or a token claim. */
  principal: string | null;
  /** The caller's IP address, or the provider's placeholder for it. */
  sourceIp: string | null;
  /** The user agent the client sent. The client chooses it, so it proves nothing. */
  userAgent: string | null;
  /** The provider's id for the request or the log entry. */
  requestId: string | null;
  /** The key version that signed, as the log names it. */
  keyVersion: string | null;
  /** The signed digest as `0x`-prefixed lowercase hex. */
  digest: string | null;
  /** The key as the log names it: a key ARN, a resource name or a key URL. */
  keyResource: string | null;
  /** Other fields of the entry, shown as they are. Never put key ids or account ids here. */
  extra?: Readonly<Record<string, KmsHistoryExtraValue>> | undefined;
  /**
   * Other fields of the entry that identify keys, accounts or credentials, such as an AWS access
   * key id. Shown only with `--show-ids`.
   */
  extraIds?: Readonly<Record<string, string | null>> | undefined;
}

/**
 * A note a reader adds to the result, printed on standard error and listed in the JSON output.
 *
 * @experimental May gain optional fields before 1.0.
 */
export interface KmsHistoryNote {
  /** A stable code in lowercase letters, digits and `-`, such as `other-account`. */
  code: string;
  /** The note for the user, in one or two sentences. */
  message: string;
}

/**
 * What a reader returns: the events it read, newest first, and what the provider's log can and
 * cannot show. A reader that cannot read the log throws instead; it never returns an empty
 * result for a log it could not read.
 *
 * @experimental May gain optional fields before 1.0.
 */
export interface KmsHistoryResult {
  /** Where the events come from, as a stable id such as `cloudtrail-event-history`. */
  source: string;
  /** The fields this provider never records for a sign request. */
  notLogged: readonly KmsHistoryField[];
  /** The events in the range, newest first, at most `limit` of them. */
  events: readonly KmsHistoryEvent[];
  /** Whether the log holds more events in the range than `limit`. */
  truncated: boolean;
  /**
   * Whether the provider logs every sign request on the key with no setting that turns it off,
   * as AWS CloudTrail event history does. When it is `false`, an empty result gets the
   * `logging-not-confirmed` note.
   */
  loggingAlwaysOn: boolean;
  /**
   * What to check when the log returns no events, such as the setting that turns logging on.
   * Added to the `logging-not-confirmed` note.
   */
  setupHint?: string | undefined;
  /** How many minutes the provider documents an event can take to appear, if it documents it. */
  deliveryDelayMinutes?: number | undefined;
  /** How many days the log keeps events, when that does not depend on the user's settings. */
  retentionDays?: number | undefined;
  /** Notes of the reader's own. */
  notes?: readonly KmsHistoryNote[] | undefined;
}
