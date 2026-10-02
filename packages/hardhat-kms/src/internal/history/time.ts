import { ERRORS } from "../error-catalog.ts";
import { catalogError } from "../errors.ts";

/** The range `kms history` reads when `--since` is not given: the last 24 hours. */
const DEFAULT_SINCE_MS: number = 24 * 60 * 60 * 1000;

/** The most events one run of `kms history` returns. */
export const MAX_LIMIT: number = 1000;

const DURATION = /^(\d{1,6})([smhd])$/;
const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

// A date, or a date and time with seconds optional and a time zone required.
const ISO_TIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/**
 * Whether the date and time fields of an ISO 8601 time exist, so that `2026-02-30` or `25:00` is
 * refused instead of rolled over.
 */
function fieldsExist(match: RegExpExecArray): boolean {
  // An absent time field reads as 0, which is always valid.
  const field = (index: number): number => Number(match[index] ?? 0);
  const [year, month, day] = [field(1), field(2), field(3)];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    field(4) <= 23 &&
    field(5) <= 59 &&
    field(6) <= 59
  );
}

/**
 * Reads a `--since` or `--until` value: an ISO 8601 time with a time zone, a date (midnight UTC),
 * or a duration before `now` in seconds, minutes, hours or days, such as `30m` or `7d`.
 *
 * @param value - The value from the command line.
 * @param option - `since` or `until`, for the error message.
 * @param now - The current time.
 * @returns The time.
 */
export function parseHistoryTime(value: string, option: "since" | "until", now: Date): Date {
  const duration = DURATION.exec(value);
  if (duration !== null) {
    const amount = Number(duration[1]);
    const unit = UNIT_MS[duration[2] ?? ""] ?? 0;
    return new Date(now.getTime() - amount * unit);
  }
  const iso = ISO_TIME.exec(value);
  if (iso !== null && fieldsExist(iso)) {
    const time = Date.parse(value);
    if (Number.isFinite(time)) {
      return new Date(time);
    }
  }
  throw catalogError(ERRORS.historyTimeInvalid, { option, value }, { operation: "history" });
}

/**
 * Reads the range and limit of `kms history`, with the defaults: the last 24 hours, 100 events.
 *
 * @param options - The `--since`, `--until` and `--limit` values.
 * @param now - The current time.
 * @returns The checked range and limit.
 */
export function historyRange(
  options: { since: string | undefined; until: string | undefined; limit: number },
  now: Date,
): { since: Date; until: Date; limit: number } {
  const until = options.until === undefined ? now : parseHistoryTime(options.until, "until", now);
  const since =
    options.since === undefined
      ? new Date(until.getTime() - DEFAULT_SINCE_MS)
      : parseHistoryTime(options.since, "since", now);
  if (since.getTime() >= until.getTime()) {
    throw catalogError(
      ERRORS.historyRangeEmpty,
      { since: since.toISOString(), until: until.toISOString() },
      { operation: "history" },
    );
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_LIMIT) {
    throw catalogError(
      ERRORS.historyLimitRange,
      { max: MAX_LIMIT, limit: options.limit },
      { operation: "history" },
    );
  }
  return { since, until, limit: options.limit };
}
