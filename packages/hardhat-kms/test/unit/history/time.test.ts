import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardhatPluginError } from "hardhat/plugins";

import {
  historyRange,
  MAX_LIMIT,
  parseHistoryTime,
  parseLoggedTime,
} from "../../../src/internal/history/time.ts";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function rejects(run: () => unknown, message: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof HardhatPluginError);
    assert.match(error.message, message);
    return true;
  });
}

/** The limit `historyRange` accepts with the default range. */
function limitOf(limit: number): number {
  return historyRange({ since: undefined, until: undefined, limit }, NOW).limit;
}

describe("parseHistoryTime", () => {
  it("reads a duration in seconds, minutes, hours or days as a time before now", () => {
    assert.equal(parseHistoryTime("45s", "since", NOW).getTime(), NOW.getTime() - 45_000);
    assert.equal(parseHistoryTime("30m", "since", NOW).getTime(), NOW.getTime() - 30 * 60_000);
    assert.equal(parseHistoryTime("6h", "since", NOW).getTime(), NOW.getTime() - 6 * HOUR);
    assert.equal(parseHistoryTime("7d", "since", NOW).getTime(), NOW.getTime() - 7 * 24 * HOUR);
    assert.equal(parseHistoryTime("0m", "until", NOW).getTime(), NOW.getTime());
  });

  it("reads an ISO 8601 time with Z or an offset, and a date as midnight UTC", () => {
    assert.equal(
      parseHistoryTime("2026-10-01T10:00:00Z", "since", NOW).toISOString(),
      "2026-10-01T10:00:00.000Z",
    );
    assert.equal(
      parseHistoryTime("2026-10-01T10:00:00.250+02:00", "since", NOW).toISOString(),
      "2026-10-01T08:00:00.250Z",
    );
    assert.equal(
      parseHistoryTime("2026-10-01T10:00-05:30", "since", NOW).toISOString(),
      "2026-10-01T15:30:00.000Z",
    );
    assert.equal(
      parseHistoryTime("2026-10-01", "since", NOW).toISOString(),
      "2026-10-01T00:00:00.000Z",
    );
    assert.equal(
      parseHistoryTime("2024-02-29", "since", NOW).toISOString(),
      "2024-02-29T00:00:00.000Z",
    );
  });

  it("knows leap years before 0100, which Date.UTC maps to the 1900s", () => {
    assert.equal(
      parseHistoryTime("0000-02-29", "since", NOW).toISOString(),
      "0000-02-29T00:00:00.000Z",
    );
    rejects(() => parseHistoryTime("0001-02-29", "since", NOW), /is not a time/);
    rejects(() => parseHistoryTime("0100-02-29", "since", NOW), /is not a time/);
  });

  it("refuses a time without a time zone, which could mean any zone", () => {
    rejects(
      () => parseHistoryTime("2026-10-01T10:00:00", "since", NOW),
      /--since "2026-10-01T10:00:00" is not a time/,
    );
  });

  it("refuses dates and times that do not exist instead of rolling them over", () => {
    for (const value of [
      "2026-02-29",
      "2026-02-30",
      "2026-13-01",
      "2026-00-10",
      "2026-04-31",
      "2026-10-00",
      "2026-10-01T24:00Z",
      "2026-10-01T10:60Z",
      "2026-10-01T10:00:60Z",
    ]) {
      rejects(() => parseHistoryTime(value, "until", NOW), /--until .* is not a time/);
    }
  });

  it("refuses other forms, and names the option and the accepted forms", () => {
    for (const value of ["", "yesterday", "6 h", "6H", "-6h", "1.5h", "6w", "1700000000", "now"]) {
      rejects(
        () => parseHistoryTime(value, "since", NOW),
        /is not a time\. Use an ISO 8601 time with a time zone, such as 2026-10-02T09:00:00Z, a date such as 2026-10-02, or a duration before now, such as 30m, 6h or 7d/,
      );
    }
  });
});

describe("historyRange", () => {
  it("defaults to the 24 hours before now and 100 events", () => {
    const range = historyRange({ since: undefined, until: undefined, limit: 100 }, NOW);

    assert.deepEqual(range, {
      since: new Date(NOW.getTime() - 24 * HOUR),
      until: NOW,
      limit: 100,
    });
  });

  it("puts the default start 24 hours before --until", () => {
    const range = historyRange({ since: undefined, until: "2026-09-01T00:00:00Z", limit: 5 }, NOW);

    assert.equal(range.since.toISOString(), "2026-08-31T00:00:00.000Z");
    assert.equal(range.until.toISOString(), "2026-09-01T00:00:00.000Z");
  });

  it("refuses a start that is not before the end, and names both", () => {
    rejects(
      () => historyRange({ since: "1h", until: "2h", limit: 100 }, NOW),
      /--since \(2026-10-02T11:00:00\.000Z\) must be before --until \(2026-10-02T10:00:00\.000Z\)/,
    );
    rejects(
      () => historyRange({ since: "2026-10-01T00:00:00Z", until: "2026-10-01", limit: 100 }, NOW),
      /must be before --until/,
    );
    rejects(
      () => historyRange({ since: "2026-10-03", until: undefined, limit: 100 }, NOW),
      /must be before --until/,
    );
  });

  it("rounds the start down and the end up to whole seconds", () => {
    const range = historyRange(
      { since: "2026-10-01T10:00:00.250Z", until: "2026-10-01T11:00:00.001Z", limit: 1 },
      NOW,
    );

    assert.equal(range.since.toISOString(), "2026-10-01T10:00:00.000Z");
    assert.equal(range.until.toISOString(), "2026-10-01T11:00:01.000Z");
    const whole = historyRange(
      { since: "2026-10-01T10:00:00Z", until: "2026-10-01T11:00:00Z", limit: 1 },
      NOW,
    );
    assert.equal(whole.until.toISOString(), "2026-10-01T11:00:00.000Z");
  });

  it("refuses an --until more than 5 minutes after now", () => {
    rejects(
      () => historyRange({ since: undefined, until: "2026-10-02T12:05:01Z", limit: 1 }, NOW),
      /--until \(2026-10-02T12:05:01\.000Z\) is more than 5 minutes after now \(2026-10-02T12:00:00\.000Z\)/,
    );
    assert.equal(
      historyRange(
        { since: undefined, until: "2026-10-02T12:05:00Z", limit: 1 },
        NOW,
      ).until.toISOString(),
      "2026-10-02T12:05:00.000Z",
    );
  });

  it("accepts a limit from 1 to the maximum and refuses others", () => {
    assert.equal(limitOf(1), 1);
    assert.equal(limitOf(MAX_LIMIT), MAX_LIMIT);
    assert.equal(MAX_LIMIT, 1000);
    for (const limit of [0, -1, MAX_LIMIT + 1, 1.5, Number.NaN]) {
      rejects(() => limitOf(limit), /--limit must be an integer from 1 to 1000, got/);
    }
  });
});

describe("parseLoggedTime", () => {
  it("reads the fractions and offsets the providers log, to the millisecond", () => {
    // Google Cloud logs nanoseconds, Azure seven digits, AWS whole seconds.
    for (const [time, expected] of [
      ["2026-10-02T08:25:00.123456789Z", "2026-10-02T08:25:00.123Z"],
      ["2026-10-02T08:25:00.123456Z", "2026-10-02T08:25:00.123Z"],
      ["2026-10-02T08:25:00.1234567+00:00", "2026-10-02T08:25:00.123Z"],
      ["2026-10-02T08:25:00+02:00", "2026-10-02T06:25:00.000Z"],
    ] as const) {
      assert.equal(new Date(parseLoggedTime(time) ?? Number.NaN).toISOString(), expected, time);
    }
  });
});
