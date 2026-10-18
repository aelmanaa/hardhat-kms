// The adapter's debug lines. A logger reads DEBUG when it is created, as its module loads, so this
// file sets it first and imports the modules that log afterwards.
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

process.env.DEBUG = "hardhat:kms:turnkey";
process.env.DEBUG_COLORS = "no";

const { TurnkeyClient } = await import("../../src/internal/client.ts");
const { createTurnkeyKeyAdapter } = await import("../../src/internal/adapter.ts");
const { apiKeyFromPrivateKey } = await import("../../src/internal/stamp.ts");
const keys = await import("../helpers/keys.ts");
const { testTransport } = await import("../helpers/transport.ts");
const { SIGN_PATH, TurnkeyStub, turnkeyError } = await import("../helpers/turnkey-stub.ts");

/** Runs `work` and returns the debug lines it wrote. */
async function linesOf(work: () => Promise<unknown>): Promise<string[]> {
  let written = "";
  const write = mock.method(process.stderr, "write", (chunk: unknown) => {
    written += String(chunk);
    return true;
  });
  try {
    await work().catch(() => undefined);
  } finally {
    write.mock.restore();
  }
  return written.split("\n").filter((line) => line.includes("hardhat:kms:turnkey"));
}

function setUp() {
  const stub = new TurnkeyStub({
    organizationId: keys.ORGANIZATION,
    apiPublicKey: keys.API_PUBLIC_KEY,
    secretKey: keys.ACCOUNT_SECRET_KEY,
  });
  const transport = testTransport(stub);
  // Each reading of the clock is 7 ms after the last, so every request takes 7 ms.
  let time = 0;
  transport.now = () => (time += 7);
  const apiKey = apiKeyFromPrivateKey(keys.API_PRIVATE_KEY);
  assert.ok(apiKey);
  const client = new TurnkeyClient(transport, apiKey, "turnkey:<ORG>/0x0");
  const ctx = {
    signal: new AbortController().signal,
    operation: "sign digest",
    requestId: "req-1",
    forbiddenHint: "",
  };
  return { stub, transport, client, ctx };
}

/**
 * The part of each line after the namespace, without the time since the previous line that the
 * debug logger adds at the end, such as ` +12ms`, or ` +-13ms` when the clock steps back.
 */
function messages(lines: string[]): string[] {
  return lines.map((line) =>
    line
      .slice(line.indexOf("hardhat:kms:turnkey ") + "hardhat:kms:turnkey ".length)
      .replace(/ \+-?\d+ms$/, ""),
  );
}

describe("the Turnkey adapter's debug lines", () => {
  it("are read without the timing suffix, a negative one too", () => {
    assert.deepEqual(
      messages([
        "  hardhat:kms:turnkey req-1: activity ACTIVITY_STATUS_PENDING +0ms",
        "  hardhat:kms:turnkey req-1: activity ACTIVITY_STATUS_PENDING +12ms",
        "  hardhat:kms:turnkey req-1: activity ACTIVITY_STATUS_COMPLETED +-13ms",
      ]),
      [
        "req-1: activity ACTIVITY_STATUS_PENDING",
        "req-1: activity ACTIVITY_STATUS_PENDING",
        "req-1: activity ACTIVITY_STATUS_COMPLETED",
      ],
    );
  });

  it("logs each answer's status, code and time, and nothing else", async () => {
    const { stub, client, ctx } = setUp();
    stub.answer(
      { status: 500, text: "" },
      turnkeyError(429, "RATE_LIMIT_EXCEEDED", "organization secret"),
      { status: 200, json: {} },
      turnkeyError(403, "REQUEST_NOT_AUTHORIZED", "organization secret"),
      { status: 302, text: "", headers: { location: "https://elsewhere.test" } },
    );

    const lines = await linesOf(async () => {
      await client.send(SIGN_PATH, "{}", ctx);
      await client.send(SIGN_PATH, "{}", ctx).catch(() => undefined);
      await client.send(SIGN_PATH, "{}", ctx);
    });

    assert.deepEqual(messages(lines), [
      "req-1 /public/v1/submit/sign_raw_payload: HTTP 500 in 7 ms",
      "req-1 /public/v1/submit/sign_raw_payload: HTTP 429 RATE_LIMIT_EXCEEDED in 7 ms",
      "req-1 /public/v1/submit/sign_raw_payload: HTTP 200 in 7 ms",
      "req-1 /public/v1/submit/sign_raw_payload: HTTP 403 REQUEST_NOT_AUTHORIZED in 7 ms",
      "req-1 /public/v1/submit/sign_raw_payload: HTTP 302 in 7 ms, a redirect",
    ]);
  });

  it("logs a request that got no answer with its reason and attempt", async () => {
    const { client, ctx, transport } = setUp();
    transport.fetch = async () =>
      await Promise.reject(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
        }),
      );

    const lines = await linesOf(async () => await client.send(SIGN_PATH, "{}", ctx));

    assert.deepEqual(messages(lines), [
      "req-1 /public/v1/submit/sign_raw_payload: no answer (ECONNREFUSED), attempt 1",
      "req-1 /public/v1/submit/sign_raw_payload: no answer (ECONNREFUSED), attempt 2",
      "req-1 /public/v1/submit/sign_raw_payload: no answer (ECONNREFUSED), attempt 3",
      "req-1 /public/v1/submit/sign_raw_payload: no answer (ECONNREFUSED), attempt 4",
    ]);
  });

  it("logs each activity status the adapter reads", async () => {
    const { stub, transport } = setUp();
    stub.firstStatus = "ACTIVITY_STATUS_PENDING";
    stub.pendingPolls = 1;
    const adapter = await createTurnkeyKeyAdapter(keys.turnkeyKey(), { transport });
    const ctx = keys.signContext();

    const lines = await linesOf(
      async () => await adapter.signDigest?.({ digest: new Uint8Array(32) }, ctx),
    );

    assert.deepEqual(
      messages(lines).filter((line) => line.includes(": activity ")),
      [
        "req-1: activity ACTIVITY_STATUS_PENDING",
        "req-1: activity ACTIVITY_STATUS_PENDING",
        "req-1: activity ACTIVITY_STATUS_COMPLETED",
      ],
    );
    const all = lines.join("\n");
    for (const value of [
      keys.ORGANIZATION,
      keys.API_PRIVATE_KEY,
      keys.API_PUBLIC_KEY,
      "00000000-0000-4000",
    ]) {
      assert.ok(!all.includes(value), value);
    }
  });
});
