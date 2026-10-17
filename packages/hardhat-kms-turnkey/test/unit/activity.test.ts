import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  activityName,
  failureCode,
  readActivity,
  SIGN_RAW_PAYLOAD,
  signatureOf,
} from "../../src/internal/activity.ts";

const ORGANIZATION = "a3c1e9f2-5b7d-4e8a-9c0f-1d2e3f4a5b6c";
const ID = "0e4c8a12-3b5d-4f6e-8a9b-0c1d2e3f4a5b";

function answer(changes: Record<string, unknown> = {}): unknown {
  return {
    activity: {
      id: ID,
      organizationId: ORGANIZATION,
      status: "ACTIVITY_STATUS_COMPLETED",
      type: SIGN_RAW_PAYLOAD,
      result: { signRawPayloadResult: { r: "01", s: "02", v: "00" } },
      ...changes,
    },
  };
}

describe("readActivity", () => {
  it("reads every status Turnkey documents", () => {
    for (const status of [
      "ACTIVITY_STATUS_CREATED",
      "ACTIVITY_STATUS_PENDING",
      "ACTIVITY_STATUS_COMPLETED",
      "ACTIVITY_STATUS_FAILED",
      "ACTIVITY_STATUS_REJECTED",
      "ACTIVITY_STATUS_CONSENSUS_NEEDED",
      "ACTIVITY_STATUS_AUTHENTICATORS_NEEDED",
    ]) {
      const activity = readActivity(answer({ status }), { organizationId: ORGANIZATION });
      assert.ok(!("kind" in activity), status);
      assert.equal(activity.status, status);
      assert.equal(activity.id, ID);
    }
  });

  it("keeps the result and the failure for the next step", () => {
    const failure = { code: 3, details: [] };
    const activity = readActivity(answer({ failure }), { organizationId: ORGANIZATION });
    assert.ok(!("kind" in activity));
    assert.equal(activity.failure, failure);
    assert.deepEqual(activity.result, { signRawPayloadResult: { r: "01", s: "02", v: "00" } });
    assert.equal(activity.organizationId, ORGANIZATION);
    assert.equal(activity.type, SIGN_RAW_PAYLOAD);
  });

  it("compares the organization in any case", () => {
    const activity = readActivity(answer({ organizationId: ORGANIZATION.toUpperCase() }), {
      organizationId: ORGANIZATION,
    });
    assert.ok(!("kind" in activity));
    const configured = readActivity(answer(), { organizationId: ORGANIZATION.toUpperCase() });
    assert.ok(!("kind" in configured));
  });

  it("refuses an answer without an activity or one of its fields", () => {
    const malformed = {
      kind: "malformed",
      problem: "the answer has no activity with an id, an organization, a type and a status",
    };
    for (const body of [
      undefined,
      null,
      "text",
      {},
      { activity: null },
      { activity: "x" },
      answer({ id: 1 }),
      answer({ organizationId: undefined }),
      answer({ type: null }),
      answer({ status: 2 }),
    ]) {
      assert.deepEqual(readActivity(body, { organizationId: ORGANIZATION }), malformed);
    }
  });

  it("refuses another organization, activity type or activity id", () => {
    assert.deepEqual(
      readActivity(answer({ organizationId: "00000000-0000-0000-0000-000000000000" }), {
        organizationId: ORGANIZATION,
      }),
      { kind: "mismatch", field: "organization" },
    );
    assert.deepEqual(
      readActivity(answer({ type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2" }), {
        organizationId: ORGANIZATION,
      }),
      { kind: "mismatch", field: "activity type" },
    );
    assert.deepEqual(
      readActivity(answer(), { organizationId: ORGANIZATION, id: `${ID.slice(0, -1)}0` }),
      { kind: "mismatch", field: "activity" },
    );
    const same = readActivity(answer(), { organizationId: ORGANIZATION, id: ID });
    assert.ok(!("kind" in same));
  });

  it("refuses a status it does not know, after the identity checks", () => {
    assert.deepEqual(
      readActivity(answer({ status: "ACTIVITY_STATUS_SOMETHING_NEW" }), {
        organizationId: ORGANIZATION,
      }),
      { kind: "malformed", problem: "the activity has a status this plugin does not know" },
    );
    assert.deepEqual(
      readActivity(answer({ status: "toString" }), { organizationId: ORGANIZATION }),
      { kind: "malformed", problem: "the activity has a status this plugin does not know" },
    );
    assert.deepEqual(
      readActivity(answer({ status: "unknown", type: "OTHER" }), { organizationId: ORGANIZATION }),
      { kind: "mismatch", field: "activity type" },
    );
  });
});

/** An activity result with the given r, s and v. */
function result(r: unknown, s: unknown, v: unknown): unknown {
  return { signRawPayloadResult: { r, s, v } };
}

describe("signatureOf", () => {
  it("reads r and s of 1 to 64 hex characters, in any case", () => {
    const r = "f".repeat(64);
    assert.deepEqual(signatureOf(result(r, "A", "00")), {
      r: 2n ** 256n - 1n,
      s: 10n,
      yParity: 0,
    });
  });

  it("reads each form of v as the parity it means", () => {
    for (const [v, yParity] of [
      ["00", 0],
      ["01", 1],
      ["1b", 0],
      ["1c", 1],
      ["1B", 0],
      ["1C", 1],
    ] as const) {
      const signature = signatureOf(result("1", "2", v));
      assert.ok(!("kind" in signature));
      assert.equal(signature.yParity, yParity, v);
    }
  });

  it("refuses a missing result, or r, s or v of the wrong type", () => {
    const problem = { kind: "malformed", problem: "the completed activity has no r, s and v" };
    for (const value of [
      undefined,
      {},
      { signRawPayloadResult: null },
      result(1, "2", "00"),
      result("1", undefined, "00"),
      result("1", "2", 0),
    ]) {
      assert.deepEqual(signatureOf(value), problem);
    }
  });

  it("refuses r or s that is empty, too long, prefixed or not hex", () => {
    for (const bad of ["", "0".repeat(65), "0x01", "1g", " 1", "1\n"]) {
      assert.deepEqual(signatureOf(result(bad, "2", "00")), {
        kind: "malformed",
        problem: "r is not 1 to 64 hex characters",
      });
      assert.deepEqual(signatureOf(result("1", bad, "00")), {
        kind: "malformed",
        problem: "s is not 1 to 64 hex characters",
      });
    }
  });

  it("refuses any other v", () => {
    for (const v of ["0", "1", "02", "1d", "1a", "25", "0x00", "", "000"]) {
      assert.deepEqual(signatureOf(result("1", "2", v)), {
        kind: "malformed",
        problem: "v is not 00, 01, 1b or 1c",
      });
    }
  });
});

describe("failureCode", () => {
  it("takes the first safe turnkeyErrorCode of the failure's details", () => {
    assert.equal(
      failureCode({
        code: 7,
        message: "organization f81d4fae is not allowed",
        details: [
          { "@type": "x" },
          { turnkeyErrorCode: "lower_case" },
          { turnkeyErrorCode: 12 },
          { turnkeyErrorCode: "POLICY_DENIED" },
          { turnkeyErrorCode: "SECOND" },
        ],
      }),
      "POLICY_DENIED",
    );
  });

  it("says no code when there is none it may show", () => {
    for (const failure of [
      undefined,
      null,
      {},
      { details: "x" },
      { details: [null, "CODE"] },
      { details: [{ turnkeyErrorCode: "A".repeat(65) }] },
      { details: [{ turnkeyErrorCode: "CODE WITH SPACE" }] },
      { details: [{ turnkeyErrorCode: "1CODE" }] },
      // A value that is not a string, even one whose text would pass.
      { details: [{ turnkeyErrorCode: ["CODE"] }] },
    ]) {
      assert.equal(failureCode(failure), "no code");
    }
    assert.equal(
      failureCode({ details: [{ turnkeyErrorCode: `A${"_".repeat(63)}` }] }),
      `A${"_".repeat(63)}`,
    );
  });
});

describe("activityName", () => {
  it("shows a UUID, in any case", () => {
    assert.equal(activityName(ID), `activity ${ID}`);
    assert.equal(activityName(ID.toUpperCase()), `activity ${ID.toUpperCase()}`);
  });

  it("hides anything else", () => {
    for (const id of [
      `${ID}x`,
      `x${ID}`,
      ID.replaceAll("-", ""),
      "organization f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
      "",
    ]) {
      assert.equal(activityName(id), "the activity (its id is not shown)");
    }
  });
});
