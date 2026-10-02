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
 * The history covers the whole key: every version, even when the config pins one. Each event
 * names its version in `keyVersion` where the provider logs it.
 *
 * @experimental May gain optional fields before 1.0.
 */
export interface KmsHistoryRequest {
  /** The resolved key, as `kms.createKeyAdapter` receives it. */
  key: KmsKeyConfig;
  /**
   * The start of the range, inclusive, on a whole second. Filter the provider's answer to the
   * range too: provider queries may round their bounds.
   */
  since: Date;
  /** The end of the range, inclusive, on a whole second. Always after `since`. */
  until: Date;
  /**
   * How many events `kms history` shows, the newest ones. Return at most `limit + 1` events: the
   * extra one tells the plugin there are more, and it then marks the result truncated. An
   * integer from 1 to 1000.
   */
  limit: number;
  /**
   * Aborts when `kms history` stops waiting for the reader: 120 seconds after the read starts.
   * Pass it to the log SDK's calls and stop paging when it fires. The plugin fails the read with
   * `core.history.timed-out` at that time even when the reader ignores it. Set by the plugin on
   * every request; optional so that a reader called by other code still type-checks.
   */
  signal?: AbortSignal | undefined;
}

/**
 * One sign event as the provider's audit log records it. Every field is copied from the log
 * entry, with no value guessed or filled in. A field the provider records but left empty in this
 * entry is `null`, and so is a field listed in {@link KmsHistoryResult.notLogged}.
 *
 * `kms history` prints `principal`, `sourceIp`, `userAgent`, `requestId`, `keyVersion`, `digest`
 * and `extra` as they are, and the error code. It shows `keyResource`, `errorMessage` and
 * `extraIds` only with `--show-ids`. By default it replaces a key resource found in another field
 * with the key's display id, and an `extraIds` value with `<hidden>`.
 *
 * @experimental May gain optional fields before 1.0.
 */
export interface KmsHistoryEvent {
  /**
   * When the provider logged the request: an ISO 8601 date and time that exists, with `Z` or an
   * offset. The plugin shows it in UTC, to the millisecond.
   */
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
  /**
   * The id the provider assigned to the request. A provider that logs none, such as Google Cloud,
   * lists `requestId` in `notLogged`; a log entry's own id, such as Google Cloud's `insertId`, goes
   * in `extra`.
   */
  requestId: string | null;
  /**
   * The key version that signed: the version id alone, such as `1` or an Azure version segment,
   * never a resource name or URL. Letters, digits, `.`, `_` and `-`, at most 64 characters.
   */
  keyVersion: string | null;
  /** The signed digest as `0x`-prefixed lowercase hex. */
  digest: string | null;
  /** The key as the log names it: a key ARN, a resource name or a key URL. */
  keyResource: string | null;
  /**
   * Other fields of the entry, shown as they are. Never put key ids or account ids here. Each name
   * starts with a letter, then up to 63 letters, digits, `_` and `.`.
   */
  extra?: Readonly<Record<string, KmsHistoryExtraValue>> | undefined;
  /**
   * Other fields of the entry that identify keys, accounts or credentials, such as an AWS access
   * key id. Shown only with `--show-ids`; without it, their values are masked as `<hidden>`
   * wherever they appear. Names as in `extra`.
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
  /** The note for the user, in one or two sentences. No key ids or account ids. */
  message: string;
}

/**
 * Which part of the log a read covered, printed in the header of `kms history`.
 *
 * @experimental May gain optional fields before 1.0.
 */
export interface KmsHistoryScope {
  /** What the read covered, free of ids, such as `us-east-1`. */
  description: string;
  /**
   * Ids that bound the read, by name, such as `{ account: "111122223333" }`. Shown only with
   * `--show-ids`; otherwise each prints as `<name> <hidden>`, and its value is masked as `<hidden>`
   * wherever it appears, except in principals, which are shown as logged. Names as in
   * {@link KmsHistoryEvent.extra}.
   */
  ids?: Readonly<Record<string, string>> | undefined;
}

/**
 * What a reader returns: the events it read, newest first, and what the provider's log can and
 * cannot show. A reader that cannot read the log throws instead; it never returns an empty
 * result for a log it could not read.
 *
 * Never put key ids, account ids or other identifiers in `source`, `scope.description`,
 * `setupHint`, note messages or the errors a reader throws: they are printed without
 * `--show-ids`.
 *
 * @experimental May gain optional fields before 1.0.
 */
export interface KmsHistoryResult {
  /**
   * Where the events come from, as a stable id of lowercase words joined by `-`, such as
   * `cloudtrail-event-history`: letters only, no digits, at most 64 characters. It is printed as
   * it is, so it cannot carry an account or project number.
   */
  source: string;
  /** The fields this provider never records for a sign request. */
  notLogged: readonly KmsHistoryField[];
  /** The events in the range, newest first, at most `limit + 1` of them. */
  events: readonly KmsHistoryEvent[];
  /**
   * Whether the log may hold events in the range that the result leaves out. Also set when the
   * reader stopped early; see `truncatedReason`.
   */
  truncated: boolean;
  /**
   * Why the result is truncated, required when `truncated` is `true` and refused otherwise:
   * `limit` when the log holds more events in the range than `limit`, with at least `limit` events
   * returned, and `scan-limit` when the reader stopped before reading the whole range, for example
   * after scanning as many log entries as it allows itself. A result with `limit + 1` events and
   * `truncated: false` is marked truncated by `limit` by the plugin.
   */
  truncatedReason?: "limit" | "scan-limit" | undefined;
  /**
   * Whether every sign request on this key is visible to this read: the provider logs every
   * sign request with no setting that turns it off, and the credentials and location of the
   * read see all of them. On AWS this holds only when the caller's account is the key ARN's
   * account and the read is in the key's Region, since CloudTrail event history is kept per
   * account and Region. When it is `false`, an empty result gets the `logging-not-confirmed`
   * note.
   */
  completeForKey: boolean;
  /** Which part of the log the read covered, such as one account and Region. */
  scope?: KmsHistoryScope | undefined;
  /**
   * Other values that must not print, such as the key ARN an alias resolved to. Without
   * `--show-ids`, the plugin replaces them and the parts they contain, in any case and in their
   * URL-encoded and `\/`-escaped forms, with `<hidden>` wherever they appear.
   */
  hiddenValues?: readonly string[] | undefined;
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
