import { ERRORS } from "../error-catalog.ts";
import { catalogError } from "../errors.ts";

/** The range `kms history` reads when `--since` is not given: the last 24 hours. */
const DEFAULT_SINCE_MS: number = 24 * 60 * 60 * 1000;

/** How far past now `--until` may be, for clocks that differ a little. */
const MAX_FUTURE_MS: number = 5 * 60 * 1000;

/** The most events one run of `kms history` returns. */
export const MAX_LIMIT: number = 1000;

const SECOND_MS = 1000;

const DURATION = /^(\d{1,6})([smhd])$/;
const UNIT_MS: Readonly<Record<string, number>> = {
  s: SECOND_MS,
  m: 60 * SECOND_MS,
  h: 60 * 60 * SECOND_MS,
  d: 24 * 60 * 60 * SECOND_MS,
};

// A date, or a date and time with seconds optional and a time zone required.
const ISO_TIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

// A date and time with seconds and a time zone, as providers log them.
const LOGGED_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** The number of days in a month, for any year from 0000 to 9999. */
function daysInMonth(year: number, month: number): number {
  // Date.UTC maps the years 0 to 99 to 1900 to 1999, so set the full year explicitly.
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

/**
 * Whether the date and time fields of an ISO 8601 time exist, so that `2026-02-30` or `25:00` is
 * refused instead of rolled over.
 */
function fieldsExist(match: RegExpExecArray): boolean {
  // An absent time field reads as 0, which is always valid.
  const field = (index: number): number => Number(match[index] ?? 0);
  const [year, month, day] = [field(1), field(2), field(3)];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    field(4) <= 23 &&
    field(5) <= 59 &&
    field(6) <= 59
  );
}

/**
 * Reads a time a reader logged: an ISO 8601 date and time with seconds and a time zone, whose
 * date and time exist.
 *
 * @param value - The time from the reader.
 * @returns Milliseconds since the epoch, or `undefined` if the value is not such a time.
 */
export function parseLoggedTime(value: string): number | undefined {
  const match = LOGGED_TIME.exec(value);
  if (match === null || !fieldsExist(match)) {
    return undefined;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
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
 * The start is rounded down and the end up to whole seconds, so the range printed is the range
 * read, whatever precision the provider's query takes.
 *
 * @param options - The `--since`, `--until` and `--limit` values.
 * @param now - The current time.
 * @returns The checked range and limit.
 */
export function historyRange(
  options: { since: string | undefined; until: string | undefined; limit: number },
  now: Date,
): { since: Date; until: Date; limit: number } {
  const givenUntil =
    options.until === undefined ? now : parseHistoryTime(options.until, "until", now);
  if (givenUntil.getTime() > now.getTime() + MAX_FUTURE_MS) {
    throw catalogError(
      ERRORS.historyUntilFuture,
      { until: givenUntil.toISOString(), now: now.toISOString() },
      { operation: "history" },
    );
  }
  const givenSince =
    options.since === undefined
      ? new Date(givenUntil.getTime() - DEFAULT_SINCE_MS)
      : parseHistoryTime(options.since, "since", now);
  if (givenSince.getTime() >= givenUntil.getTime()) {
    throw catalogError(
      ERRORS.historyRangeEmpty,
      { since: givenSince.toISOString(), until: givenUntil.toISOString() },
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
  return {
    since: new Date(Math.floor(givenSince.getTime() / SECOND_MS) * SECOND_MS),
    until: new Date(Math.ceil(givenUntil.getTime() / SECOND_MS) * SECOND_MS),
    limit: options.limit,
  };
}
