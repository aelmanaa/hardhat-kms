// The Turnkey smoke test's harness (test/live/smoke.ts), offline: the signature cap with the real
// adapter against the stub, a used-up quota, the redaction and the findings.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { serializeTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createTurnkeyKeyAdapter } from "../../src/internal/adapter.ts";
import {
  ACCOUNT,
  ACCOUNT_SECRET_KEY,
  API_PUBLIC_KEY,
  ORGANIZATION,
  signContext,
  turnkeyKey,
} from "../helpers/keys.ts";
import { BASE_URL, testTransport } from "../helpers/transport.ts";
import { SIGN_PATH, TurnkeyStub, turnkeyError } from "../helpers/turnkey-stub.ts";
import {
  legacyV,
  LiveRecorder,
  liveRedactor,
  runCase,
  SIGNATURE_CAP,
  scrub,
  VARIABLES,
} from "../live/smoke.ts";

const noRedaction = (text: string): string => text;

function stub(): TurnkeyStub {
  return new TurnkeyStub({
    organizationId: ORGANIZATION,
    apiPublicKey: API_PUBLIC_KEY,
    secretKey: ACCOUNT_SECRET_KEY,
  });
}

/** An adapter whose requests go through the recorder to `inner`. */
async function recordedAdapter(inner: typeof fetch) {
  const recorder = new LiveRecorder(inner, { gapMs: 0 });
  const transport = testTransport(stub());
  const adapter = await createTurnkeyKeyAdapter(turnkeyKey(), {
    transport: { ...transport, baseUrl: BASE_URL, fetch: recorder.fetch },
  });
  return { recorder, adapter, transport };
}

const digest = (index: number): Uint8Array => new Uint8Array(32).fill(index + 1);

describe("the smoke test's signature cap", () => {
  it("sends 11 sign requests and never sends the 12th", async () => {
    const turnkey = stub();
    const { recorder, adapter, transport } = await recordedAdapter(turnkey.fetch);
    assert.equal(SIGNATURE_CAP, 11);

    for (let index = 0; index < SIGNATURE_CAP; index++) {
      transport.time += 1000;
      await adapter.signDigest?.({ digest: digest(index) }, signContext());
    }
    assert.equal(recorder.signatures, 11);
    assert.equal(turnkey.requests.length, 11);

    const outcome = await runCase(recorder, "the 12th", noRedaction, async () => {
      transport.time += 1000;
      await adapter.signDigest?.({ digest: digest(12) }, signContext());
      return undefined;
    });

    assert.equal(outcome.kind, "failed");
    assert.match(outcome.kind === "failed" ? outcome.message : "", /SignatureCapReached/);
    assert.match(outcome.kind === "failed" ? outcome.message : "", /past the cap of 11/);
    assert.equal(turnkey.requests.length, 11, "the 12th request reached Turnkey");
    assert.equal(recorder.signatures, 11);
    assert.ok(recorder.refused >= 1);
    assert.ok(recorder.exchanges.some((exchange) => exchange.status === "not sent"));
  });

  it("counts a retried body once, since Turnkey answers it with the same activity", async () => {
    const turnkey = stub();
    turnkey.answer(turnkeyError(500));
    const { recorder, adapter } = await recordedAdapter(turnkey.fetch);

    await adapter.signDigest?.({ digest: digest(0) }, signContext());

    assert.equal(turnkey.bodies(SIGN_PATH).length, 2);
    assert.equal(recorder.signatures, 1);
    assert.deepEqual(
      recorder.exchanges.map((exchange) => exchange.status),
      [500, 200],
    );
  });

  it("does not count queries", async () => {
    const turnkey = stub();
    turnkey.firstStatus = "ACTIVITY_STATUS_PENDING";
    turnkey.pendingPolls = 1;
    const { recorder, adapter } = await recordedAdapter(turnkey.fetch);

    await adapter.signDigest?.({ digest: digest(0) }, signContext());

    assert.equal(recorder.signatures, 1);
    assert.deepEqual(
      recorder.exchanges.map((exchange) => [exchange.path, exchange.activity]),
      [
        ["sign_raw_payload", "ACTIVITY_STATUS_PENDING"],
        ["get_activity", "ACTIVITY_STATUS_PENDING"],
        ["get_activity", "ACTIVITY_STATUS_COMPLETED"],
      ],
    );
  });

  it("spaces requests by the gap", async () => {
    let clock = 0;
    const waits: number[] = [];
    const recorder = new LiveRecorder(stub().fetch, {
      gapMs: 1100,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
        await Promise.resolve();
      },
    });
    const body = JSON.stringify({ organizationId: ORGANIZATION, activityId: "x" });
    await recorder.fetch(`${BASE_URL}/public/v1/query/get_activity`, { method: "POST", body });
    clock += 100;
    await recorder.fetch(`${BASE_URL}/public/v1/query/get_activity`, { method: "POST", body });
    assert.deepEqual(waits, [1000]);
  });
});

describe("a used-up quota", () => {
  it('ends the run as "quota used up", not as a failure, and skips the cases after it', async () => {
    const turnkey = stub();
    turnkey.answer(turnkeyError(429, "SIGNING_QUOTA_EXCEEDED"));
    const { recorder, adapter } = await recordedAdapter(turnkey.fetch);

    const outcome = await runCase(recorder, "personal_sign", noRedaction, async () => {
      await adapter.signMessage?.(
        { message: new Uint8Array([1]), digest: new Uint8Array(32) },
        signContext(),
      );
      return undefined;
    });
    assert.deepEqual(outcome, { kind: "quota" });
    assert.equal(recorder.quotaUsedUp, true);
    assert.equal(turnkey.requests.length, 1, "a used-up quota is not retried");

    let ran = false;
    const next = await runCase(recorder, "typed data", noRedaction, async () => {
      ran = true;
      return undefined;
    });
    assert.deepEqual(next, { kind: "quota" });
    assert.equal(ran, false);
  });

  it("keeps a rate limit a failure, after the plugin's retries", async () => {
    const turnkey = stub();
    for (let attempt = 0; attempt < 4; attempt++) {
      turnkey.answer(turnkeyError(429, "RATE_LIMIT_EXCEEDED"));
    }
    const { recorder, adapter } = await recordedAdapter(turnkey.fetch);

    const outcome = await runCase(recorder, "digest", noRedaction, async () => {
      await adapter.signDigest?.({ digest: digest(0) }, signContext());
      return undefined;
    });
    assert.equal(outcome.kind, "failed");
    assert.equal(recorder.quotaUsedUp, false);
  });
});

describe("the smoke test's redaction", () => {
  const apiKey = "9c".repeat(32);
  const organization = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
  const activity = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
  const denied = "0x1111111111111111111111111111111111111111";
  const consensus = "0x2222222222222222222222222222222222222222";
  const env = {
    [VARIABLES.apiPrivateKey]: apiKey,
    [VARIABLES.organizationId]: organization,
    [VARIABLES.address]: ACCOUNT.address,
    [VARIABLES.denied]: denied,
    [VARIABLES.consensus]: consensus,
  };

  it("removes the API key, the organization id, activity ids and the other two accounts", () => {
    const publicKey = `02${"7d".repeat(32)}`;
    const redact = liveRedactor(env, [publicKey]);
    const text = redact(
      `key ${apiKey.toUpperCase()} and ${apiKey}; organization ${organization}, ${organization.toUpperCase()}; ` +
        `Turnkey holds activity ${activity}; denied ${denied} (${denied.slice(2)}); consensus ${consensus.toLowerCase()}; ` +
        `public key ${publicKey}; signed 0x02f8${"5a".repeat(100)}; r ${"0d".repeat(32)}; pinned ${ACCOUNT.address}`,
    );
    for (const value of [
      apiKey,
      organization,
      activity,
      denied.slice(2),
      consensus.slice(2),
      publicKey,
      "5a5a5a",
      "0d0d0d",
    ]) {
      assert.ok(!text.toLowerCase().includes(value.toLowerCase()), `${value} survived in: ${text}`);
    }
    assert.ok(text.includes(`pinned ${ACCOUNT.address}`), "the pinned account was removed");
  });

  it("removes a UUID glued to word characters", () => {
    const text = liveRedactor({})(`activity_${activity} id${activity}x ${activity.toUpperCase()}`);
    assert.equal(text, "activity_<uuid> id<uuid>x <uuid>");
  });

  it("redacts the message of a failed case", async () => {
    const recorder = new LiveRecorder(stub().fetch, { gapMs: 0 });
    const outcome = await runCase(recorder, "leaky", liveRedactor(env), async () => {
      throw new Error(`organization ${organization} with key ${apiKey}`, {
        cause: new Error(`activity ${activity}`),
      });
    });
    assert.equal(outcome.kind, "failed");
    const message = outcome.kind === "failed" ? outcome.message : "";
    for (const value of [apiKey, organization, activity]) {
      assert.ok(!message.includes(value), `${value} survived in: ${message}`);
    }
  });
});

describe("the smoke test's findings", () => {
  it("reads a legacy transaction's v form from its RLP", async () => {
    const account = privateKeyToAccount(`0x${"42".repeat(32)}`);
    const tx = {
      type: "legacy",
      chainId: 31_337,
      nonce: 0,
      gas: 21_000n,
      gasPrice: 1n,
      to: account.address,
      value: 0n,
    } as const;
    const eip155 = await account.signTransaction(tx);
    assert.equal(legacyV(eip155, 31_337), "eip155");
    assert.equal(legacyV(eip155, 1), "other");
    const signature = { r: `0x${"01".repeat(32)}`, s: `0x${"02".repeat(32)}` } as const;
    assert.equal(
      legacyV(
        serializeTransaction({ ...tx, chainId: undefined }, { ...signature, v: 27n }),
        31_337,
      ),
      "27/28",
    );
  });

  it("records the form of r, s and v, and whether s was high, without their values", async () => {
    const turnkey = stub();
    turnkey.mode = "high-s";
    const { recorder, adapter } = await recordedAdapter(turnkey.fetch);

    await adapter.signDigest?.({ digest: digest(0) }, signContext());

    const [exchange] = recorder.exchanges;
    assert.deepEqual(exchange?.finding, {
      kind: "raw-payload",
      rLength: 64,
      sLength: 64,
      v: exchange?.finding?.v,
      prefixed: false,
      highS: true,
    });
    assert.match(exchange?.finding?.v ?? "", /^0[01]$/);
    assert.equal(typeof exchange?.ms, "number");
    const shape = JSON.stringify(Object.fromEntries(recorder.shapes));
    assert.ok(shape.includes("ACTIVITY_STATUS_COMPLETED"));
    assert.ok(!shape.includes(ORGANIZATION));
  });

  it("scrubs an answer down to its shape", () => {
    assert.deepEqual(
      scrub({
        activity: {
          id: "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d",
          status: "ACTIVITY_STATUS_COMPLETED",
          type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
          votes: [{ user: "TEST_USER", count: 2 }],
          canReject: false,
        },
      }),
      {
        activity: {
          id: "<string:36>",
          status: "ACTIVITY_STATUS_COMPLETED",
          type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
          votes: [{ user: "<string:9>", count: "<number>" }],
          canReject: false,
        },
      },
    );
  });
});
