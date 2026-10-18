// A dry run of the Turnkey smoke test's cases (test/live/cases.ts) against the local stub, so a
// mistake in the cases shows here and not in a live run, where each try spends signatures. The
// stub stands in for the policies: it answers 403 for the denied account and for create_api_keys,
// ACTIVITY_STATUS_CONSENSUS_NEEDED for the consensus account, and refuses a stale timestamp.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { getAddress } from "viem";

import {
  ACCOUNT,
  ACCOUNT_SECRET_KEY,
  API_PRIVATE_KEY,
  API_PUBLIC_KEY,
  ORGANIZATION,
} from "../helpers/keys.ts";
import { BASE_URL } from "../helpers/transport.ts";
import { TurnkeyStub, turnkeyError } from "../helpers/turnkey-stub.ts";
import { openSmoke, type Smoke, SMOKE_CASES } from "../live/cases.ts";
import { LiveRecorder, liveRedactor, runCase, SIGNATURE_CAP } from "../live/smoke.ts";

const DENIED = getAddress("0x00000000000000000000000000000000000000d1");
const CONSENSUS = getAddress("0x00000000000000000000000000000000000000c5");
const PENDING_ID = "5e1f0c2a-3b4d-4e6f-8a9b-0c1d2e3f4a5b";
const VARIABLES = {
  organizationId: "HHKMS_TEST_SMOKE_TURNKEY_ORGANIZATION",
  apiPrivateKey: "HHKMS_TEST_SMOKE_TURNKEY_API_PRIVATE_KEY",
};

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const stub = new TurnkeyStub({
  organizationId: ORGANIZATION,
  apiPublicKey: API_PUBLIC_KEY,
  secretKey: ACCOUNT_SECRET_KEY,
});

/** Turnkey as the smoke test's owner setup makes it, with the stub signing for the allowed account. */
async function turnkey(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input);
  const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
  const signWith = field(field(body, "parameters"), "signWith");
  switch (url.pathname) {
    case "/public/v1/query/whoami":
      return json(200, { organizationId: ORGANIZATION, userId: "user-1", username: "api" });
    case "/public/v1/submit/create_api_keys":
      return Number(field(body, "timestampMs")) < Date.now() - 3_600_000
        ? json(401, turnkeyError(401, undefined, "the request's timestamp is too old").json)
        : json(403, turnkeyError(403, "REQUEST_NOT_AUTHORIZED").json);
    default:
  }
  if (signWith === DENIED) {
    return json(403, turnkeyError(403, "REQUEST_NOT_AUTHORIZED").json);
  }
  if (signWith === CONSENSUS) {
    return json(200, {
      activity: {
        id: PENDING_ID,
        organizationId: ORGANIZATION,
        status: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
        type: field(body, "type"),
      },
    });
  }
  return await stub.fetch(input, init);
}

describe("the Turnkey smoke test's cases, against the stub", () => {
  const recorder = new LiveRecorder(turnkey, { gapMs: 0 });
  const redact = liveRedactor({});
  let smoke: Smoke | undefined;

  before(async () => {
    process.env[VARIABLES.organizationId] = ORGANIZATION;
    process.env[VARIABLES.apiPrivateKey] = API_PRIVATE_KEY;
    smoke = await openSmoke({
      address: ACCOUNT.address,
      denied: DENIED,
      consensus: CONSENSUS,
      variables: VARIABLES,
      transport: { baseUrl: BASE_URL, fetch: recorder.fetch },
      recorder,
    });
  });

  after(() => {
    smoke?.close();
    for (const name of Object.values(VARIABLES)) {
      Reflect.deleteProperty(process.env, name);
    }
  });

  it("passes every case but the Sepolia send, within the cap, recording each answer", async () => {
    const shared = smoke;
    assert.ok(shared !== undefined);
    const outcomes = [];
    for (const item of SMOKE_CASES) {
      outcomes.push({
        name: item.name,
        ...(await runCase(recorder, item.name, redact, async () => await item.run(shared))),
      });
    }

    assert.deepEqual(
      outcomes.filter((outcome) => outcome.kind !== "passed"),
      [
        {
          name: "one EIP-1559 self-send of 0 wei on Sepolia (optional)",
          kind: "skipped",
          reason: "not asked for: dispatch with sepolia-send to run it",
        },
      ],
    );
    assert.equal(recorder.signatures, SIGNATURE_CAP - 1);
    assert.equal(recorder.refused, 0);
    const notes = outcomes.map((outcome) => ("note" in outcome ? outcome.note : undefined));
    assert.ok(notes.includes("403 REQUEST_NOT_AUTHORIZED"));
    assert.ok(notes.includes("HTTP 401"));
    assert.ok(
      notes.includes("reject activity 5e1f0c2a-… in the Turnkey dashboard (Activities, pending)"),
    );

    const signs = recorder.exchanges.filter((exchange) => exchange.finding !== undefined);
    assert.deepEqual(
      signs.map((exchange) => [exchange.path, exchange.finding?.transactionType]),
      [
        ["sign_raw_payload", undefined],
        ["sign_raw_payload", undefined],
        ["sign_raw_payload", undefined],
        ["sign_raw_payload", undefined],
        ["sign_transaction", "eip1559"],
        ["sign_transaction", "legacy"],
        ["sign_transaction", "eip7702"],
        ["sign_raw_payload", undefined],
      ],
    );
    // viem writes the stub's legacy v in the EIP-155 form, the form the plugin requires; the live
    // run records Turnkey's.
    assert.equal(signs[5]?.finding?.legacyV, "eip155");
    assert.ok(
      recorder.shapes.has("ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2 ACTIVITY_STATUS_CONSENSUS_NEEDED"),
    );
    assert.ok(recorder.shapes.has("HTTP 403"));
  });
});
