import type {
  KmsHistoryEvent,
  KmsHistoryExtraValue,
  KmsHistoryField,
  KmsHistoryNote,
  KmsHistoryResult,
} from "./types.ts";

/** One sign event in the output of `kms history`. */
export interface KmsHistoryEntry {
  /** When the provider logged the request, in UTC. */
  time: string;
  /** The provider's name for the operation, such as `Sign`. */
  operation: string;
  outcome: "success" | "failed";
  /**
   * For a failed request, the provider's error code, and with `--show-ids` its message, which can
   * name accounts and keys. `null` for a request that succeeded.
   */
  error: { code: string | null; message: string | null } | null;
  /** Who made the request, as logged. */
  principal: string | null;
  /** The caller's IP address, as logged. */
  sourceIp: string | null;
  /** The user agent the client reported. Any client can send any value. */
  userAgent: string | null;
  /** The provider's id for the request or the log entry. */
  requestId: string | null;
  /** The key version that signed, as logged. */
  keyVersion: string | null;
  /** The signed digest as `0x` hex, where the provider logs it. */
  digest: string | null;
  /**
   * The key as the log names it. Without `--show-ids` it shows as the key's display id, since a
   * key ARN, resource name or key URL names the account, project or vault.
   */
  keyResource: string | null;
  /** Other fields of the log entry. Ids of keys, accounts and credentials only with `--show-ids`. */
  extra: Record<string, KmsHistoryExtraValue>;
}

/** What `kms history` returns and what `--json` prints. */
export interface KmsHistoryReport {
  /** The version of this shape. */
  version: 1;
  /** The key, by the name the task was given and its display id. */
  key: { name: string; provider: string; displayId: string };
  /** Where the events come from, such as `cloudtrail-event-history`. */
  source: string;
  /** The range read, in UTC. */
  range: { since: string; until: string };
  /** The fields this provider never records. They are `null` in every event. */
  notLogged: KmsHistoryField[];
  /** The events, newest first. */
  events: KmsHistoryEntry[];
  /** Whether the log holds more events in the range than `--limit`. */
  truncated: boolean;
  /** Warnings about what the events may not show, also printed on standard error. */
  notes: KmsHistoryNote[];
}

/** Within this many minutes of now, an event may not have reached the log yet. */
const RECENT_WINDOW_MINUTES: number = 15;

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * The notes the plugin adds to a result: an empty result that does not prove the key signed
 * nothing, a range that ends too recently for every event to have arrived, and a range that
 * starts before the log's retention. The reader's own notes follow.
 *
 * @param result - The checked result.
 * @param range - The range read.
 * @param now - The current time.
 * @param providerName - The provider's name for messages, such as `AWS KMS`.
 * @returns The notes.
 */
export function historyNotes(
  result: KmsHistoryResult,
  range: { since: Date; until: Date },
  now: Date,
  providerName: string,
): KmsHistoryNote[] {
  const notes: KmsHistoryNote[] = [];
  if (result.events.length === 0 && !result.loggingAlwaysOn) {
    notes.push({
      code: "logging-not-confirmed",
      message: [
        "The log returned no sign events in this range. That does not show that the key signed nothing: logging may be off or sent elsewhere, or the credentials may not see every entry.",
        ...(result.setupHint === undefined ? [] : [result.setupHint]),
      ].join(" "),
    });
  }
  const delay = result.deliveryDelayMinutes;
  const window = Math.max(RECENT_WINDOW_MINUTES, delay ?? 0);
  if (range.until.getTime() > now.getTime() - window * MINUTE_MS) {
    notes.push({
      code: "recent-events-may-be-missing",
      message: `Events from the last ${window} minutes may not be in the log yet: ${
        delay === undefined
          ? `${providerName} does not document how long delivery takes`
          : `${providerName} documents a delivery delay of about ${delay} minutes`
      }.`,
    });
  }
  const retention = result.retentionDays;
  if (retention !== undefined) {
    const oldest = new Date(now.getTime() - retention * DAY_MS);
    if (range.since.getTime() < oldest.getTime()) {
      notes.push({
        code: "before-retention",
        message: `The log keeps ${retention} days of events, so it holds none from before ${oldest.toISOString()}.`,
      });
    }
  }
  return [...notes, ...(result.notes ?? [])];
}

/** Values shorter than this are never replaced, so that masking cannot garble ordinary text. */
const MIN_HIDDEN_LENGTH = 8;

/**
 * Replaces each hidden value in a text with the key's display id.
 *
 * @param hidden - The values to hide, longest first.
 * @param displayId - What to show instead.
 * @returns The masking function.
 */
function masker(hidden: readonly string[], displayId: string): (text: string) => string {
  return (text) => hidden.reduce((masked, value) => masked.split(value).join(displayId), text);
}

/** What {@link buildHistoryReport} needs. */
export interface HistoryReportInput {
  /** The name the task was given. */
  name: string;
  key: { provider: string; displayId: string };
  range: { since: Date; until: Date };
  result: KmsHistoryResult;
  notes: KmsHistoryNote[];
  showIds: boolean;
  /**
   * Values that identify the key beyond its display id, such as a configuration variable's value.
   * Hidden like key resources without `--show-ids`.
   */
  hiddenValues: readonly string[];
}

/**
 * Builds the report `kms history` prints. Without `--show-ids`, each event's key resource shows
 * as the key's display id, error messages and `extraIds` are left out, and any of their values,
 * or of `hiddenValues`, found in another field is replaced with the display id.
 *
 * @param input - The key, the range, the checked result and the notes.
 * @returns The report.
 */
export function buildHistoryReport(input: HistoryReportInput): KmsHistoryReport {
  const { key, result, showIds } = input;
  const hidden = [
    ...input.hiddenValues,
    ...result.events.flatMap((event) => [
      event.keyResource,
      ...Object.values(event.extraIds ?? {}),
    ]),
  ]
    .flatMap((value) => (value !== null && value.length >= MIN_HIDDEN_LENGTH ? [value] : []))
    .toSorted((a, b) => b.length - a.length);
  const mask = showIds ? (text: string): string => text : masker(hidden, key.displayId);
  const maskOrNull = (text: string | null): string | null => (text === null ? null : mask(text));

  const entry = (event: KmsHistoryEvent): KmsHistoryEntry => ({
    time: event.time,
    operation: mask(event.operation),
    outcome: event.outcome,
    error:
      event.outcome === "failed"
        ? {
            code: maskOrNull(event.errorCode),
            message: showIds ? event.errorMessage : null,
          }
        : null,
    principal: maskOrNull(event.principal),
    sourceIp: maskOrNull(event.sourceIp),
    userAgent: maskOrNull(event.userAgent),
    requestId: maskOrNull(event.requestId),
    keyVersion: maskOrNull(event.keyVersion),
    digest: event.digest,
    keyResource: event.keyResource === null ? null : showIds ? event.keyResource : key.displayId,
    extra: Object.fromEntries([
      ...Object.entries(event.extra ?? {}).map(([field, value]): [string, KmsHistoryExtraValue] => [
        field,
        typeof value === "string" ? mask(value) : value,
      ]),
      ...(showIds ? Object.entries(event.extraIds ?? {}) : []),
    ]),
  });

  return {
    version: 1,
    key: { name: input.name, provider: key.provider, displayId: key.displayId },
    source: result.source,
    range: { since: input.range.since.toISOString(), until: input.range.until.toISOString() },
    notLogged: [...result.notLogged],
    events: result.events.map(entry),
    truncated: result.truncated,
    notes: input.notes.map((note) => ({ code: note.code, message: mask(note.message) })),
  };
}

/** How the table and its lines name each field. */
const FIELD_LABELS: Readonly<Record<KmsHistoryField, string>> = {
  principal: "principal",
  sourceIp: "source IP",
  userAgent: "user agent",
  requestId: "request id",
  keyVersion: "key version",
  digest: "digest",
};

/**
 * Renders a report as the lines of the `kms history` table: a header that names the key, the
 * source, the range and the fields the provider does not log, then one row per event with its
 * longer fields on the lines under it. A field the provider does not log has no column or line;
 * a field it logged empty shows as `-`.
 *
 * @param report - The report.
 * @returns The lines, without newlines.
 */
export function renderHistoryTable(report: KmsHistoryReport): string[] {
  const logged = (field: KmsHistoryField): boolean => !report.notLogged.includes(field);
  const lines = [
    `Sign events of ${report.key.name} (${report.key.displayId}), from ${report.source}`,
    `${report.range.since} to ${report.range.until}, newest first`,
  ];
  if (report.notLogged.length > 0) {
    lines.push(
      `Not logged by this provider: ${report.notLogged.map((field) => FIELD_LABELS[field]).join(", ")}`,
    );
  }
  lines.push("");
  if (report.events.length === 0) {
    lines.push("No sign events in the log for this range.");
    return lines;
  }

  const columns: Array<[string, (event: KmsHistoryEntry) => string | null]> = [
    ["TIME", (event) => event.time],
    ["OPERATION", (event) => event.operation],
    [
      "OUTCOME",
      (event) =>
        event.outcome === "success" ? "success" : `failed (${event.error?.code ?? "no code"})`,
    ],
  ];
  if (logged("principal")) {
    columns.push(["PRINCIPAL", (event) => event.principal]);
  }
  if (logged("sourceIp")) {
    columns.push(["SOURCE IP", (event) => event.sourceIp]);
  }
  if (logged("keyVersion")) {
    columns.push(["KEY VERSION", (event) => event.keyVersion]);
  }
  const rows = report.events.map((event) => columns.map(([, cell]) => cell(event) ?? "-"));
  const widths = columns.map(([title], column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const format = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  lines.push(format(columns.map(([title]) => title)));

  report.events.forEach((event, index) => {
    lines.push(format(rows[index] ?? []));
    const detail = (label: string, value: string | null): void => {
      lines.push(`  ${label}: ${value ?? "-"}`);
    };
    if (logged("userAgent")) {
      detail("user agent (client-reported)", event.userAgent);
    }
    if (logged("requestId")) {
      detail("request id", event.requestId);
    }
    if (logged("digest")) {
      detail("digest", event.digest);
    }
    if (event.keyResource !== null && event.keyResource !== report.key.displayId) {
      detail("key", event.keyResource);
    }
    if (event.error?.message !== null && event.error?.message !== undefined) {
      detail("error", event.error.message);
    }
    for (const [field, value] of Object.entries(event.extra)) {
      detail(field, value === null ? null : String(value));
    }
  });
  return lines;
}
