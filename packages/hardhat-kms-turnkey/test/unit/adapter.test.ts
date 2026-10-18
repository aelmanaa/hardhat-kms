import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { KmsKeyAdapter, SignatureOutput, TurnkeyKmsKeyConfig } from "hardhat-kms/types";

import {
  personalMessageDigest,
  typedDataDigest,
} from "../../../hardhat-kms/src/internal/crypto/digests.ts";
import { EIP712_MAIL } from "../../../hardhat-kms/test/helpers/vectors.ts";
import {
  createTurnkeyKeyAdapter,
  FIRST_POLL_MS,
  MAX_POLL_MS,
  WAITING_MESSAGE,
} from "../../src/internal/adapter.ts";
import { apiKeyFromPrivateKey } from "../../src/internal/stamp.ts";
import {
  ACCOUNT,
  ACCOUNT_SECRET_KEY,
  API_PRIVATE_KEY,
  API_PUBLIC_KEY,
  OTHER_API_PRIVATE_KEY,
  ORGANIZATION,
  signContext,
  turnkeyKey,
} from "../helpers/keys.ts";
import { type TestTransport, testTransport } from "../helpers/transport.ts";
import {
  POLL_PATH,
  SIGN_PATH,
  SIGN_TYPE,
  type StubAnswer,
  TurnkeyStub,
  turnkeyError,
} from "../helpers/turnkey-stub.ts";

const DIGEST = new Uint8Array(32).map((_, index) => index + 1);
const MESSAGE = new TextEncoder().encode("hello");
const ACTIVITY_ID = "0e4c8a12-3b5d-4f6e-8a9b-0c1d2e3f4a5b";
/** Turnkey's message, planted: no error may quote it. */
const TURNKEY_MESSAGE = 'request is targeting organization ("Planted Org Name")';

async function setUp(
  key: TurnkeyKmsKeyConfig = turnkeyKey(),
  options: { onWait?: (ms: number) => void } = {},
): Promise<{ stub: TurnkeyStub; transport: TestTransport; adapter: KmsKeyAdapter }> {
  const stub = new TurnkeyStub({
    organizationId: ORGANIZATION,
    apiPublicKey: API_PUBLIC_KEY,
    secretKey: ACCOUNT_SECRET_KEY,
  });
  const transport = testTransport(stub, options);
  const adapter = await createTurnkeyKeyAdapter(key, { transport });
  return { stub, transport, adapter };
}

/** Calls one of the three methods. */
async function sign(
  adapter: KmsKeyAdapter,
  method: "digest" | "message" | "typedData",
  ctx = signContext(),
): Promise<SignatureOutput> {
  const signature =
    method === "digest"
      ? await adapter.signDigest?.({ digest: DIGEST }, ctx)
      : method === "message"
        ? await adapter.signMessage?.({ message: MESSAGE, digest: DIGEST }, ctx)
        : await adapter.signTypedData?.({ typedData: EIP712_MAIL, digest: DIGEST }, ctx);
  assert.ok(signature, `the adapter has no ${method} method`);
  return signature;
}

/** The digest the core expects for each method. */
function expectedDigest(method: "digest" | "message" | "typedData"): Uint8Array {
  return method === "digest"
    ? DIGEST
    : method === "message"
      ? personalMessageDigest(MESSAGE)
      : typedDataDigest(EIP712_MAIL);
}

/** An activity answer in Turnkey's shape. */
function activity(status: string, changes: Record<string, unknown> = {}): StubAnswer {
  return {
    status: 200,
    json: {
      activity: {
        id: ACTIVITY_ID,
        organizationId: ORGANIZATION,
        status,
        type: SIGN_TYPE,
        ...changes,
      },
    },
  };
}

/** Checks an error's text, and that it holds no planted value. */
function failsWith(pattern: RegExp, allowActivityId = false): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, pattern);
    const planted = [
      TURNKEY_MESSAGE,
      "Planted Org Name",
      ORGANIZATION,
      API_PRIVATE_KEY,
      API_PUBLIC_KEY,
    ];
    if (!allowActivityId) {
      planted.push(ACTIVITY_ID);
    }
    for (const value of planted) {
      assert.ok(
        !error.message.toLowerCase().includes(value.toLowerCase()),
        `${value} in ${error.message}`,
      );
    }
    return true;
  };
}

const METHODS = ["digest", "message", "typedData"] as const;

describe("the Turnkey adapter", () => {
  it("describes the key by its checksummed address", async () => {
    const { adapter } = await setUp();
    assert.deepEqual(adapter.describe(), {
      provider: "turnkey",
      pinnedId: ACCOUNT.address,
      displayId: `turnkey:<TURNKEY_ORGANIZATION_ID>/${ACCOUNT.address}`,
    });
    assert.equal("getPublicKey" in adapter, false);
    assert.equal("getAddress" in adapter, false);
  });

  it("reads no credential and sends nothing until the first signature", async () => {
    const key = turnkeyKey({}, { publicKey: API_PUBLIC_KEY });
    const { stub } = await setUp(key);
    assert.equal(stub.requests.length, 0);
    for (const identifier of [key.apiPrivateKey, key.apiPublicKey, key.organizationId]) {
      assert.equal(Reflect.get(identifier ?? {}, "reads"), 0);
    }
  });

  const bodies = {
    digest: {
      payload: Buffer.from(DIGEST).toString("hex"),
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NO_OP",
    },
    message: {
      payload: Buffer.concat([
        Buffer.from("\x19Ethereum Signed Message:\n5", "utf8"),
        Buffer.from(MESSAGE),
      ]).toString("hex"),
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_KECCAK256",
    },
    typedData: {
      encoding: "PAYLOAD_ENCODING_EIP712",
      hashFunction: "HASH_FUNCTION_NO_OP",
    },
  } as const;

  for (const method of METHODS) {
    it(`sends ${method} as Turnkey's sign_raw_payload, and returns the signature`, async () => {
      const { stub, adapter, transport } = await setUp();

      const signature = await sign(adapter, method);

      const [body] = stub.bodies();
      assert.equal(stub.requests[0]?.path, SIGN_PATH);
      assert.ok(typeof body === "object" && body !== null);
      assert.deepEqual(Object.keys(body), ["type", "timestampMs", "organizationId", "parameters"]);
      const fields: Record<string, unknown> = Object.fromEntries(Object.entries(body));
      const { type, timestampMs, organizationId, parameters } = fields;
      assert.equal(type, "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2");
      assert.equal(timestampMs, String(transport.time));
      assert.equal(organizationId, ORGANIZATION);
      assert.ok(typeof parameters === "object" && parameters !== null);
      assert.equal(Reflect.get(parameters, "signWith"), ACCOUNT.address);
      assert.deepEqual(Object.keys(parameters), [
        "signWith",
        "payload",
        "encoding",
        "hashFunction",
      ]);
      for (const [name, value] of Object.entries(bodies[method])) {
        assert.equal(Reflect.get(parameters, name), value, name);
      }

      // The signature is the stub's, over the digest the core expects.
      assert.ok("r" in signature);
      const recovered = new secp256k1.Signature(signature.r, signature.s)
        .addRecoveryBit(signature.yParity ?? 0)
        .recoverPublicKey(expectedDigest(method));
      assert.deepEqual(recovered.toBytes(), secp256k1.getPublicKey(ACCOUNT_SECRET_KEY));
    });
  }

  it("sends a new, later timestampMs for each signature, even when the clock stands still", async () => {
    const { stub, adapter, transport } = await setUp();
    await sign(adapter, "digest");
    await sign(adapter, "digest");
    transport.time -= 5000;
    await sign(adapter, "digest");
    transport.time += 10_000;
    await sign(adapter, "digest");

    const times = stub.bodies().map((body) => Number(Reflect.get(body ?? {}, "timestampMs")));
    const start = transport.time - 5000;
    assert.deepEqual(times, [start, start + 1, start + 2, start + 5000]);
    // Different bodies: Turnkey makes a new activity for each, as the core's fresh attempt needs.
    assert.equal(new Set(stub.requests.map((request) => request.body)).size, 4);
  });

  it("reads the credentials once, and again after a failure", async () => {
    const key = turnkeyKey(
      {},
      { privateKey: API_PRIVATE_KEY, publicKey: API_PUBLIC_KEY.toUpperCase() },
    );
    const { stub, adapter } = await setUp(key);
    await sign(adapter, "digest");
    await sign(adapter, "message");
    assert.equal(Reflect.get(key.apiPrivateKey, "reads"), 1);
    assert.equal(Reflect.get(key.apiPublicKey ?? {}, "reads"), 1);
    assert.equal(Reflect.get(key.organizationId, "reads"), 1);
    assert.equal(stub.requests.length, 2);

    let reads = 0;
    const flaky = turnkeyKey({
      apiPrivateKey: {
        display: "<TURNKEY_API_PRIVATE_KEY>",
        get: async () => {
          reads++;
          if (reads === 1) {
            throw new TypeError("variable not set");
          }
          return await Promise.resolve(API_PRIVATE_KEY);
        },
      },
    });
    const second = await setUp(flaky);
    await assert.rejects(sign(second.adapter, "digest"), /variable not set/);
    await sign(second.adapter, "digest");
    assert.equal(reads, 2);
  });

  it("refuses an API private key that is not 64 hex characters, before any request", async () => {
    for (const privateKey of [API_PUBLIC_KEY, "", "zz".repeat(32), "00".repeat(32)]) {
      const { stub, adapter } = await setUp(turnkeyKey({}, { privateKey }));
      await assert.rejects(
        sign(adapter, "digest"),
        failsWith(
          /^turnkey, sign digest, key turnkey:<TURNKEY_ORGANIZATION_ID>\/0x[0-9a-fA-F]{40}: the API private key is not a P-256 private key/,
        ),
      );
      assert.equal(stub.requests.length, 0);
    }
  });

  it("refuses an API public key of another pair, before any request", async () => {
    const other = apiKeyFromPrivateKey(OTHER_API_PRIVATE_KEY);
    assert.ok(other);
    const { stub, adapter } = await setUp(turnkeyKey({}, { publicKey: other.publicKey }));
    await assert.rejects(
      sign(adapter, "message"),
      failsWith(/sign message, .*: the API public key does not match the API private key/),
    );
    assert.equal(stub.requests.length, 0);
  });
});

describe("the Turnkey adapter's activities", () => {
  it("polls a pending activity until it completes, and says so once", async () => {
    const { stub, adapter, transport } = await setUp();
    stub.firstStatus = "ACTIVITY_STATUS_PENDING";
    stub.pendingPolls = 4;
    const ctx = signContext();

    const signature = await sign(adapter, "message", ctx);

    assert.ok("r" in signature);
    assert.deepEqual(
      stub.requests.map((request) => request.path),
      [SIGN_PATH, POLL_PATH, POLL_PATH, POLL_PATH, POLL_PATH, POLL_PATH],
    );
    assert.equal(FIRST_POLL_MS, 500);
    assert.equal(MAX_POLL_MS, 2000);
    assert.deepEqual(transport.waits, [500, 1000, 2000, 2000, 2000]);
    assert.deepEqual(ctx.messages, ["waiting for Turnkey to finish the activity"]);
    assert.equal(WAITING_MESSAGE, ctx.messages[0]);
    // Each poll asks for the activity the submission created; queries carry no timestamp.
    for (const body of stub.bodies(POLL_PATH)) {
      assert.deepEqual(body, {
        organizationId: ORGANIZATION,
        activityId: "00000000-0000-4000-8000-000000000001",
      });
    }
    assert.ok(stub.requests.every((request) => request.stamped));
  });

  it("polls a created activity too, and shows nothing when the first poll completes it", async () => {
    const { stub, adapter } = await setUp();
    stub.firstStatus = "ACTIVITY_STATUS_CREATED";
    const ctx = signContext();
    await sign(adapter, "digest", ctx);
    assert.equal(stub.requests.length, 2);
    assert.deepEqual(ctx.messages, []);
  });

  for (const [status, need] of [
    ["ACTIVITY_STATUS_CONSENSUS_NEEDED", "more approvals \\(ACTIVITY_STATUS_CONSENSUS_NEEDED\\)"],
    [
      "ACTIVITY_STATUS_AUTHENTICATORS_NEEDED",
      "another authenticator \\(ACTIVITY_STATUS_AUTHENTICATORS_NEEDED\\)",
    ],
  ] as const) {
    it(`fails at once on ${status}, and names the activity to reject`, async () => {
      const { stub, adapter } = await setUp();
      stub.answer(activity(status));
      await assert.rejects(
        sign(adapter, "typedData"),
        failsWith(
          new RegExp(
            `sign typed data, .*: Turnkey holds activity ${ACTIVITY_ID} until it gets ${need}\\. The plugin does not wait for approvals, and the activity stays pending in Turnkey\\. Reject it in the Turnkey dashboard`,
          ),
          true,
        ),
      );
      assert.equal(stub.requests.length, 1);
    });

    it(`fails on ${status} reached while polling`, async () => {
      const { stub, adapter } = await setUp();
      stub.answer(activity("ACTIVITY_STATUS_PENDING"), activity(status));
      const ctx = signContext();
      await assert.rejects(
        sign(adapter, "digest", ctx),
        failsWith(new RegExp(`activity ${ACTIVITY_ID} until`), true),
      );
      assert.equal(stub.requests.length, 2);
      assert.deepEqual(ctx.messages, []);
    });
  }

  it("leaves out an activity id that is not a UUID", async () => {
    const { stub, adapter } = await setUp();
    stub.answer(activity("ACTIVITY_STATUS_CONSENSUS_NEEDED", { id: "org Planted Org Name" }));
    await assert.rejects(
      sign(adapter, "digest"),
      failsWith(/Turnkey holds the activity \(its id is not shown\) until/),
    );
  });

  it("explains a failed and a rejected activity with the failure's code only", async () => {
    const failure = {
      code: 7,
      message: TURNKEY_MESSAGE,
      details: [{ turnkeyErrorCode: "POLICY_DENIED" }],
    };
    const { stub, adapter } = await setUp();
    stub.answer(
      activity("ACTIVITY_STATUS_FAILED", { failure }),
      activity("ACTIVITY_STATUS_REJECTED", { failure }),
      activity("ACTIVITY_STATUS_FAILED"),
    );
    await assert.rejects(
      sign(adapter, "digest"),
      failsWith(/: Turnkey's signing activity failed \(POLICY_DENIED\)$/),
    );
    await assert.rejects(
      sign(adapter, "digest"),
      failsWith(/: Turnkey's signing activity was rejected \(POLICY_DENIED\)$/),
    );
    await assert.rejects(
      sign(adapter, "digest"),
      failsWith(/: Turnkey's signing activity failed \(no code\)$/),
    );
  });

  for (const [name, answer, pattern] of [
    [
      "another organization",
      activity("ACTIVITY_STATUS_COMPLETED", {
        organizationId: "00000000-0000-0000-0000-000000000000",
      }),
      /Turnkey answered for another organization than the request named/,
    ],
    [
      "another activity type",
      activity("ACTIVITY_STATUS_COMPLETED", { type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2" }),
      /Turnkey answered for another activity type than the request named/,
    ],
    [
      "no activity",
      { status: 200, json: {} },
      /Turnkey answered in a form this plugin does not read: the answer has no activity/,
    ],
    [
      "an answer that is not JSON",
      { status: 200, text: "<html>" },
      /does not read: the answer has no activity/,
    ],
    [
      "an unknown status",
      activity("ACTIVITY_STATUS_PAUSED"),
      /does not read: the activity has a status this plugin does not know/,
    ],
    [
      "no signature",
      activity("ACTIVITY_STATUS_COMPLETED"),
      /does not read: the completed activity has no r, s and v/,
    ],
    [
      "a bad r",
      activity("ACTIVITY_STATUS_COMPLETED", {
        result: { signRawPayloadResult: { r: "0x1", s: "1", v: "00" } },
      }),
      /does not read: r is not 1 to 64 hex characters/,
    ],
    [
      "a bad s",
      activity("ACTIVITY_STATUS_COMPLETED", {
        result: { signRawPayloadResult: { r: "1", s: "1".repeat(65), v: "00" } },
      }),
      /does not read: s is not 1 to 64 hex characters/,
    ],
    [
      "a bad v",
      activity("ACTIVITY_STATUS_COMPLETED", {
        result: { signRawPayloadResult: { r: "1", s: "1", v: "27" } },
      }),
      /does not read: v is not 00, 01, 1b or 1c/,
    ],
  ] as const) {
    it(`refuses ${name} in the answer`, async () => {
      const { stub, adapter } = await setUp();
      stub.answer(answer);
      await assert.rejects(sign(adapter, "digest"), failsWith(pattern));
    });
  }

  it("refuses a poll answer for another activity", async () => {
    const { stub, adapter } = await setUp();
    stub.answer(
      activity("ACTIVITY_STATUS_PENDING"),
      activity("ACTIVITY_STATUS_COMPLETED", { id: "0e4c8a12-3b5d-4f6e-8a9b-0c1d2e3f4a5c" }),
    );
    await assert.rejects(
      sign(adapter, "digest"),
      failsWith(/Turnkey answered for another activity than the request named/),
    );
  });

  it("returns r, s and the parity Turnkey reported", async () => {
    const { stub, adapter } = await setUp();
    stub.answer(
      activity("ACTIVITY_STATUS_COMPLETED", {
        result: { signRawPayloadResult: { r: "0a", s: "FF", v: "1c" } },
      }),
    );
    assert.deepEqual(await sign(adapter, "digest"), { r: 10n, s: 255n, yParity: 1 });
  });
});

describe("the Turnkey adapter's errors", () => {
  for (const [method, hint] of [
    [
      "message",
      / \(a message, sent with HASH_FUNCTION_KECCAK256 and PAYLOAD_ENCODING_HEXADECIMAL: a policy that allows only HASH_FUNCTION_NO_OP denies it\)\. Add a policy/,
    ],
    [
      "typedData",
      / \(typed data, sent with PAYLOAD_ENCODING_EIP712 and HASH_FUNCTION_NO_OP: a policy that allows only PAYLOAD_ENCODING_HEXADECIMAL denies it\)\. Add a policy/,
    ],
  ] as const) {
    it(`names what a ${method} request sent in a 403`, async () => {
      const { stub, adapter } = await setUp();
      stub.answer(turnkeyError(403, "REQUEST_NOT_AUTHORIZED", TURNKEY_MESSAGE));
      await assert.rejects(sign(adapter, method), failsWith(hint));
    });
  }

  it("names neither encoding nor hash function in a 403 for a digest", async () => {
    const { stub, adapter } = await setUp();
    stub.answer(turnkeyError(403, "REQUEST_NOT_AUTHORIZED", TURNKEY_MESSAGE));
    await assert.rejects(sign(adapter, "digest"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /sign this request with this address\. Add a policy/);
      assert.doesNotMatch(error.message, /KECCAK256|EIP712|HASH_FUNCTION|PAYLOAD_ENCODING/);
      return true;
    });
  });

  it("retries a poll that failed for a moment, with the same query", async () => {
    let stub: TurnkeyStub | undefined;
    const setup = await setUp(turnkeyKey(), {
      onWait: (ms) => {
        if (ms === FIRST_POLL_MS) {
          stub?.answer(turnkeyError(503));
        }
      },
    });
    stub = setup.stub;
    stub.firstStatus = "ACTIVITY_STATUS_PENDING";

    const signature = await sign(setup.adapter, "digest");

    assert.ok("r" in signature);
    assert.deepEqual(
      stub.requests.map((request) => request.path),
      [SIGN_PATH, POLL_PATH, POLL_PATH],
    );
    const [first, second] = stub.requests.filter((request) => request.path === POLL_PATH);
    assert.equal(first?.body, second?.body);
    assert.deepEqual(setup.transport.waits, [FIRST_POLL_MS, 188]);
  });

  it("stops polling at once when the signal aborts, and sends nothing after", async () => {
    const ctx = signContext();
    const reason = new Error("timed out");
    const { stub, adapter, transport } = await setUp(turnkeyKey(), {
      onWait: (ms) => {
        if (ms === 1000) {
          ctx.controller.abort(reason);
        }
      },
    });
    stub.firstStatus = "ACTIVITY_STATUS_PENDING";
    stub.pendingPolls = 10;

    await assert.rejects(sign(adapter, "digest", ctx), (error) => error === reason);
    assert.deepEqual(transport.waits, [500, 1000]);
    assert.deepEqual(
      stub.requests.map((request) => request.path),
      [SIGN_PATH, POLL_PATH],
    );
  });

  it("sends nothing when the signal has already aborted", async () => {
    const ctx = signContext();
    ctx.controller.abort(new Error("cancelled"));
    const { stub, adapter } = await setUp();
    await assert.rejects(sign(adapter, "digest", ctx), /cancelled/);
    assert.equal(stub.requests.length, 0);
  });

  it("puts the organization from a variable in no error, and a literal one only in the key's display id", async () => {
    const literal = turnkeyKey({
      displayId: `turnkey:${ORGANIZATION}/${ACCOUNT.address}`,
      organizationId: {
        get: async () => await Promise.resolve(ORGANIZATION),
        display: ORGANIZATION,
      },
    });
    const { stub, adapter } = await setUp(literal);
    stub.answer(turnkeyError(404, "ORGANIZATION_NOT_FOUND", TURNKEY_MESSAGE));
    await assert.rejects(sign(adapter, "digest"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.split(ORGANIZATION).length, 2, error.message);
      assert.ok(error.message.startsWith(`turnkey, sign digest, key turnkey:${ORGANIZATION}/`));
      return true;
    });
  });

  it("checks the digest the stub signed against keccak-256 of the preimage it got", async () => {
    // A guard on the stub itself: it hashes the message preimage with Keccak-256, as Turnkey does.
    const { stub, adapter } = await setUp();
    await sign(adapter, "message");
    const parameters = Reflect.get(stub.bodies()[0] ?? {}, "parameters");
    const payload: unknown = Reflect.get(parameters ?? {}, "payload");
    assert.equal(typeof payload, "string");
    assert.deepEqual(
      keccak_256(Buffer.from(String(payload), "hex")),
      personalMessageDigest(MESSAGE),
    );
  });
});
