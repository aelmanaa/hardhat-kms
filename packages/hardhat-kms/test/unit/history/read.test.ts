import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseHistoryResult } from "../../../src/internal/history/read.ts";
import type { KmsHistoryRequest } from "../../../src/types.ts";
import { historyEvent, historyResult } from "../../helpers/fake-history-reader.ts";

// The key is not read by the parser; only the range and the limit are.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stand-in the parser never reads
const KEY = {} as KmsHistoryRequest["key"];
const REQUEST: KmsHistoryRequest = {
  key: KEY,
  since: new Date("2026-10-01T00:00:00Z"),
  until: new Date("2026-10-03T00:00:00Z"),
  limit: 3,
};

/** Parses a result and returns the problems found. */
function problemsOf(value: unknown, request: KmsHistoryRequest = REQUEST): string[] {
  const problems: string[] = [];
  parseHistoryResult(value, request, problems);
  return problems;
}

/** The problems of a result whose one event has this digest. */
function withDigest(digest: string): string[] {
  return problemsOf(historyResult({ notLogged: [], events: [historyEvent({ digest })] }));
}

describe("parseHistoryResult", () => {
  it("accepts a valid result and copies it", () => {
    const problems: string[] = [];
    const input = historyResult({
      setupHint: "Turn on the log.",
      notes: [{ code: "other-account", message: "Another account." }],
    });
    const parsed = parseHistoryResult(input, REQUEST, problems);

    assert.deepEqual(problems, []);
    assert.deepEqual(parsed, {
      ...input,
      notes: [{ code: "other-account", message: "Another account." }],
    });
    assert.notEqual(parsed?.events, input.events);
  });

  it("leaves out optional fields that are absent, and an empty setup hint", () => {
    const parsed = parseHistoryResult(
      {
        source: "s",
        notLogged: [],
        events: [],
        truncated: false,
        loggingAlwaysOn: false,
        setupHint: "",
      },
      REQUEST,
      [],
    );

    assert.deepEqual(parsed, {
      source: "s",
      notLogged: [],
      events: [],
      truncated: false,
      loggingAlwaysOn: false,
      notes: [],
    });
  });

  it("sorts events newest first, keeps the order of events logged at the same time, and normalises times to UTC", () => {
    const parsed = parseHistoryResult(
      historyResult({
        events: [
          historyEvent({ time: "2026-10-01T10:00:00Z", requestId: "old" }),
          historyEvent({ time: "2026-10-02T12:00:00+02:00", requestId: "same-1" }),
          historyEvent({ time: "2026-10-02T10:00:00.000Z", requestId: "same-2" }),
        ],
      }),
      REQUEST,
      [],
    );

    assert.deepEqual(
      parsed?.events.map((event) => [event.requestId, event.time]),
      [
        ["same-1", "2026-10-02T10:00:00.000Z"],
        ["same-2", "2026-10-02T10:00:00.000Z"],
        ["old", "2026-10-01T10:00:00.000Z"],
      ],
    );
  });

  it("keeps the newest events up to the limit and marks the result truncated", () => {
    const events = ["01", "02", "03", "04"].map((hour) =>
      historyEvent({ time: `2026-10-02T${hour}:00:00Z`, requestId: hour }),
    );
    const parsed = parseHistoryResult(historyResult({ events }), REQUEST, []);

    assert.deepEqual(
      parsed?.events.map((event) => event.requestId),
      ["04", "03", "02"],
    );
    assert.equal(parsed?.truncated, true);
  });

  it("keeps truncated from the reader when the events fit the limit", () => {
    assert.equal(
      parseHistoryResult(historyResult({ truncated: true }), REQUEST, [])?.truncated,
      true,
    );
    assert.equal(
      parseHistoryResult(historyResult({ truncated: false }), REQUEST, [])?.truncated,
      false,
    );
  });

  it("accepts events at both ends of the range and refuses events outside it", () => {
    assert.deepEqual(
      problemsOf(
        historyResult({
          events: [
            historyEvent({ time: "2026-10-01T00:00:00Z" }),
            historyEvent({ time: "2026-10-03T00:00:00Z" }),
          ],
        }),
      ),
      [],
    );
    assert.deepEqual(
      problemsOf(
        historyResult({
          events: [
            historyEvent({ time: "2026-09-30T23:59:59.999Z" }),
            historyEvent({ time: "2026-10-03T00:00:00.001Z" }),
          ],
        }),
      ),
      [
        "events[0].time is outside the requested range",
        "events[1].time is outside the requested range",
      ],
    );
  });

  it("refuses a value for a field the reader lists as not logged", () => {
    assert.deepEqual(problemsOf(historyResult({ events: [historyEvent({ keyVersion: "1" })] })), [
      "events[0].keyVersion has a value, but the reader lists it as not logged",
    ]);
  });

  it("refuses a digest that is not 32 bytes of lowercase 0x hex", () => {
    assert.deepEqual(withDigest(`0x${"ab".repeat(32)}`), []);
    for (const digest of [`0x${"AB".repeat(32)}`, "ab".repeat(32), `0x${"ab".repeat(31)}`]) {
      assert.deepEqual(withDigest(digest), [
        "events[0].digest must be 0x-prefixed lowercase hex of 32 bytes",
      ]);
    }
  });

  it("refuses an error on a successful event, and accepts one on a failed event", () => {
    assert.deepEqual(problemsOf(historyResult({ events: [historyEvent({ errorCode: "X" })] })), [
      "events[0] succeeded but has an error",
    ]);
    assert.deepEqual(problemsOf(historyResult({ events: [historyEvent({ errorMessage: "m" })] })), [
      "events[0] succeeded but has an error",
    ]);
    assert.deepEqual(
      problemsOf(
        historyResult({
          events: [historyEvent({ outcome: "failed", errorCode: "X", errorMessage: "m" })],
        }),
      ),
      [],
    );
  });

  it("refuses times without a time zone or that are not times", () => {
    for (const time of ["2026-10-02T09:00:00", "2026-10-02", "yesterday", "2026-10-02T25:00:00Z"]) {
      assert.deepEqual(problemsOf(historyResult({ events: [historyEvent({ time })] })), [
        "events[0].time must be an ISO 8601 time with a time zone",
      ]);
    }
  });

  it("names each malformed field of an event", () => {
    const problems = problemsOf({
      ...historyResult(),
      events: [
        {
          ...historyEvent(),
          time: 5,
          operation: "",
          outcome: "ok",
          errorCode: 1,
          errorMessage: {},
          principal: 1,
          sourceIp: 1,
          userAgent: 1,
          requestId: 1,
          keyVersion: null,
          digest: null,
          keyResource: 1,
          extra: { nested: { a: 1 }, infinite: Number.POSITIVE_INFINITY, ok: 1 },
          extraIds: { number: 1, ok: "x" },
        },
        "not an object",
        { ...historyEvent(), extra: [], extraIds: "x" },
      ],
    });

    assert.deepEqual(problems, [
      "events[0].time must be a non-empty string",
      "events[0].time must be an ISO 8601 time with a time zone",
      'events[0].outcome must be "success" or "failed"',
      "events[0].errorCode must be a string or null",
      "events[0].errorMessage must be a string or null",
      "events[0].principal must be a string or null",
      "events[0].sourceIp must be a string or null",
      "events[0].userAgent must be a string or null",
      "events[0].requestId must be a string or null",
      "events[0].operation must be a non-empty string",
      "events[0].keyResource must be a string or null",
      "events[0].extra.nested must be a string, a finite number, a boolean or null",
      "events[0].extra.infinite must be a string, a finite number, a boolean or null",
      "events[0].extraIds.number must be a string or null",
      "events[1] must be an object",
      "events[2].extra must be an object",
      "events[2].extraIds must be an object",
    ]);
  });

  it("names each malformed field of the result", () => {
    assert.deepEqual(problemsOf(null), ["the result must be an object"]);
    assert.deepEqual(problemsOf([]), ["the result must be an object"]);
    assert.deepEqual(
      problemsOf({
        source: "",
        notLogged: ["digest", "keyVersion", "digest", "signature", 3],
        events: {},
        truncated: "no",
        loggingAlwaysOn: 1,
        setupHint: 2,
        notes: {},
        deliveryDelayMinutes: 0,
        retentionDays: Number.NaN,
      }),
      [
        "result.source must be a non-empty string",
        "notLogged holds an unknown field: signature",
        "notLogged holds an unknown field: number",
        "events must be an array",
        "truncated must be a boolean",
        "loggingAlwaysOn must be a boolean",
        "setupHint must be a string when set",
        "notes must be an array when set",
        "deliveryDelayMinutes must be a positive number when set",
        "retentionDays must be a positive number when set",
      ],
    );
    assert.deepEqual(problemsOf({ ...historyResult(), notLogged: "digest" }), [
      "notLogged must be an array",
    ]);
  });

  it("accepts events without extra fields and leaves them out of the copy", () => {
    const event = { ...historyEvent(), extra: undefined, extraIds: undefined };
    const problems: string[] = [];
    const parsed = parseHistoryResult(historyResult({ events: [event] }), REQUEST, problems);

    assert.deepEqual(problems, []);
    assert.equal(parsed?.events[0] !== undefined && "extra" in parsed.events[0], false);
    assert.equal(parsed?.events[0] !== undefined && "extraIds" in parsed.events[0], false);
  });

  it("lists each not-logged field once", () => {
    assert.deepEqual(
      parseHistoryResult(
        historyResult({ notLogged: ["digest", "digest", "keyVersion"] }),
        REQUEST,
        [],
      )?.notLogged,
      ["digest", "keyVersion"],
    );
  });

  it("refuses notes without a code and a message, with a malformed code, or with a code of the plugin", () => {
    assert.deepEqual(
      problemsOf(
        historyResult({
          notes: [
            { code: "other-account", message: "m" },
            { code: "Other", message: "m" },
            { code: "a--b", message: "m" },
            { code: "logging-not-confirmed", message: "m" },
            { code: "x", message: "" },
          ],
        }),
      ),
      [
        "notes[1].code must be lowercase words joined by - and not a code of the plugin",
        "notes[2].code must be lowercase words joined by - and not a code of the plugin",
        "notes[3].code must be lowercase words joined by - and not a code of the plugin",
        "notes[4].message must be a non-empty string",
      ],
    );
    assert.deepEqual(problemsOf({ ...historyResult(), notes: [1] }), [
      "notes[0] must be an object",
    ]);
  });
});
