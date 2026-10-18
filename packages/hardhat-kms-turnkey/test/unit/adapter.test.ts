import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { KmsKeyAdapter, SignatureOutput, TurnkeyKmsKeyConfig } from "hardhat-kms/types";
import { getAddress, type Hex, serializeTransaction, type TransactionSerializable } from "viem";

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
  SIGN_TRANSACTION_PATH,
  SIGN_TRANSACTION_TYPE,
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

  it("names the hash function and encoding of a digest in a 403, and no transaction", async () => {
    const { stub, adapter } = await setUp();
    stub.answer(turnkeyError(403, "REQUEST_NOT_AUTHORIZED", TURNKEY_MESSAGE));
    await assert.rejects(sign(adapter, "digest"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /^turnkey, sign digest, key [^:]+:[^:]+: Turnkey answered 403 REQUEST_NOT_AUTHORIZED: no policy lets the API key's user sign this request with this address \(a digest, sent with HASH_FUNCTION_NO_OP and PAYLOAD_ENCODING_HEXADECIMAL: a policy that allows only SIGN_TRANSACTION, or only HASH_FUNCTION_KECCAK256, denies it\)\. Add a policy/,
      );
      assert.doesNotMatch(
        error.message,
        /a transaction|ACTIVITY_TYPE_SIGN_TRANSACTION|transactionSigning/,
      );
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

const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const CHAIN_ID = 31337;
const base = { chainId: CHAIN_ID, nonce: 4, gas: 21_000n, to: TO, value: 5n, data: "0x" } as const;
/** One transaction of each type the adapter sends to sign_transaction. */
const TRANSACTIONS: ReadonlyArray<[number, TransactionSerializable]> = [
  [0, { ...base, type: "legacy", gasPrice: 7n }],
  [1, { ...base, type: "eip2930", gasPrice: 7n, accessList: [] }],
  [2, { ...base, type: "eip1559", maxFeePerGas: 7n, maxPriorityFeePerGas: 1n }],
  [
    4,
    {
      ...base,
      type: "eip7702",
      maxFeePerGas: 7n,
      maxPriorityFeePerGas: 1n,
      authorizationList: [
        {
          address: TO,
          chainId: CHAIN_ID,
          nonce: 0,
          r: `0x${"11".repeat(32)}`,
          s: `0x${"22".repeat(32)}`,
          yParity: 0,
        },
      ],
    },
  ],
];

function hexBytes(hex: Hex): Uint8Array {
  return new Uint8Array(Buffer.from(hex.slice(2), "hex"));
}

/** The core's request for a transaction. */
function transactionRequest(type: number, tx: TransactionSerializable) {
  const unsigned = hexBytes(serializeTransaction(tx));
  return { unsigned, digest: keccak_256(unsigned), type, chainId: BigInt(CHAIN_ID) };
}

/** A completed sign_transaction activity whose result is `signed`, as Turnkey writes it. */
function signedAnswer(signed: string): StubAnswer {
  return activity("ACTIVITY_STATUS_COMPLETED", {
    type: SIGN_TRANSACTION_TYPE,
    result: { signTransactionResult: { signedTransaction: signed } },
  });
}

/** `tx` with a signature, as unprefixed hex. */
function signedHex(tx: TransactionSerializable): string {
  const signature = { r: `0x${"0a".repeat(32)}`, s: `0x${"0b".repeat(32)}` } as const;
  return serializeTransaction(
    tx,
    tx.type === "legacy" ? { ...signature, v: 27n } : { ...signature, yParity: 0 },
  ).slice(2);
}

describe("the Turnkey adapter's transactions", () => {
  it("sends the core's unsigned bytes of types 0, 1, 2 and 4 to sign_transaction, and returns the signature", async () => {
    for (const [type, tx] of TRANSACTIONS) {
      const { stub, adapter } = await setUp();
      const request = transactionRequest(type, tx);

      const signature = await adapter.signTransaction?.(request, signContext());

      assert.ok(signature && "r" in signature, `type ${type}`);
      const [body] = stub.bodies(SIGN_TRANSACTION_PATH);
      assert.deepEqual(body, {
        type: SIGN_TRANSACTION_TYPE,
        timestampMs: "1760000000000",
        organizationId: ORGANIZATION,
        parameters: {
          signWith: ACCOUNT.address,
          unsignedTransaction: Buffer.from(request.unsigned).toString("hex"),
          type: "TRANSACTION_TYPE_ETHEREUM",
        },
      });
      assert.equal(stub.requests.length, 1);
      assert.ok(stub.requests.every((sent) => sent.stamped));
      const recovered = new secp256k1.Signature(signature.r, signature.s, signature.yParity)
        .recoverPublicKey(request.digest)
        .toBytes(true);
      assert.deepEqual(recovered, secp256k1.getPublicKey(ACCOUNT_SECRET_KEY, true), `type ${type}`);
    }
  });

  it("refuses type 3, an unknown type and bytes of another type, before any request", async () => {
    const [, , [, eip1559] = [2, {}]] = TRANSACTIONS;
    const { stub, adapter } = await setUp();
    for (const type of [3, 5, 1]) {
      await assert.rejects(
        adapter.signTransaction?.(transactionRequest(type, eip1559), signContext()) ??
          Promise.resolve(),
        failsWith(
          new RegExp(
            `^turnkey, sign transaction, key turnkey:<TURNKEY_ORGANIZATION_ID>/0x[0-9a-fA-F]{40}: the plugin sends only legacy \\(EIP-155\\), EIP-2930, EIP-1559 and EIP-7702 transactions to Turnkey's sign_transaction, and this one is type ${type} or`,
          ),
        ),
      );
    }
    assert.equal(stub.requests.length, 0);
  });

  it("refuses a signed transaction with another to, value, nonce, chain or type", async () => {
    const [[, legacy] = [0, {}], , [, eip1559] = [2, {}]] = TRANSACTIONS;
    const cases: Array<[string, TransactionSerializable, TransactionSerializable]> = [
      ["to", eip1559, { ...eip1559, to: getAddress(ACCOUNT.address) }],
      ["value", eip1559, { ...eip1559, value: 6n }],
      ["nonce", eip1559, { ...eip1559, nonce: 5 }],
      ["chainId", eip1559, { ...eip1559, chainId: 1 }],
      ["type", eip1559, { ...base, type: "eip2930", gasPrice: 7n }],
      ["to", legacy, { ...legacy, to: getAddress(ACCOUNT.address) }],
      ["chainId", legacy, { ...legacy, chainId: 1 }],
      ["type", legacy, { ...base, type: "eip1559", maxFeePerGas: 7n, maxPriorityFeePerGas: 1n }],
    ];
    for (const [field, sent, returned] of cases) {
      const { stub, adapter } = await setUp();
      stub.answer(signedAnswer(signedHex(returned)));
      const type = sent.type === "legacy" ? 0 : 2;
      await assert.rejects(
        adapter.signTransaction?.(transactionRequest(type, sent), signContext()) ??
          Promise.resolve(),
        failsWith(
          new RegExp(
            `^turnkey, sign transaction, key [^:]+:[^:]+: Turnkey signed a transaction whose ${field} differs from the transaction the plugin sent\\. The plugin does not use its signature and sends nothing$`,
          ),
        ),
        `${field} of ${String(sent.type)}`,
      );
    }
  });

  it("reads a signed transaction with or without 0x", async () => {
    const [, , [type, eip1559] = [2, {}]] = TRANSACTIONS;
    for (const prefix of ["", "0x"]) {
      const { stub, adapter } = await setUp();
      stub.answer(signedAnswer(`${prefix}${signedHex(eip1559)}`));
      assert.deepEqual(
        await adapter.signTransaction?.(transactionRequest(type, eip1559), signContext()),
        { r: BigInt(`0x${"0a".repeat(32)}`), s: BigInt(`0x${"0b".repeat(32)}`), yParity: 0 },
      );
    }
  });

  it("refuses an answer without a signed transaction, or one that is not RLP", async () => {
    const [, , [type, eip1559] = [2, {}]] = TRANSACTIONS;
    for (const [answer, problem] of [
      [
        activity("ACTIVITY_STATUS_COMPLETED", {
          type: SIGN_TRANSACTION_TYPE,
          result: { signRawPayloadResult: { r: "01", s: "02", v: "00" } },
        }),
        "the completed activity has no signedTransaction",
      ],
      [signedAnswer("zz"), "signedTransaction is not hex"],
      [
        signedAnswer(signedHex(eip1559).slice(0, -2)),
        "the signed transaction is not one canonical RLP list",
      ],
    ] as const) {
      const { stub, adapter } = await setUp();
      stub.answer(answer);
      await assert.rejects(
        adapter.signTransaction?.(transactionRequest(type, eip1559), signContext()) ??
          Promise.resolve(),
        failsWith(new RegExp(`Turnkey answered in a form this plugin does not read: ${problem}$`)),
      );
    }
  });

  it("refuses a raw-payload activity for a transaction", async () => {
    const [, , [type, eip1559] = [2, {}]] = TRANSACTIONS;
    const { stub, adapter } = await setUp();
    stub.answer(activity("ACTIVITY_STATUS_COMPLETED"));
    await assert.rejects(
      adapter.signTransaction?.(transactionRequest(type, eip1559), signContext()) ??
        Promise.resolve(),
      failsWith(/Turnkey answered for another activity type than the request named/),
    );
  });

  it("names the SIGN_TRANSACTION activity in a 403", async () => {
    const [, , [type, eip1559] = [2, {}]] = TRANSACTIONS;
    const { stub, adapter } = await setUp();
    stub.answer(turnkeyError(403, "REQUEST_NOT_AUTHORIZED", TURNKEY_MESSAGE));
    await assert.rejects(
      adapter.signTransaction?.(transactionRequest(type, eip1559), signContext()) ??
        Promise.resolve(),
      failsWith(
        /^turnkey, sign transaction, key [^:]+:[^:]+: Turnkey answered 403 REQUEST_NOT_AUTHORIZED: no policy lets the API key's user sign this request with this address \(a transaction, sent as ACTIVITY_TYPE_SIGN_TRANSACTION_V2: a policy that allows only SIGN_RAW_PAYLOAD denies it; to sign the transaction's hash instead, as Foundry does, set the key's transactionSigning to "digest"\)\. Add a policy/,
      ),
    );
    assert.equal(stub.requests.length, 1);
  });

  it("retries with the same body, polls a pending activity, and fails on approval like a raw payload", async () => {
    const [, , [type, eip1559] = [2, {}]] = TRANSACTIONS;
    const { stub, adapter } = await setUp();
    stub.answer(turnkeyError(500));
    stub.firstStatus = "ACTIVITY_STATUS_PENDING";
    const ctx = signContext();

    const signature = await adapter.signTransaction?.(transactionRequest(type, eip1559), ctx);

    assert.ok(signature && "r" in signature);
    assert.deepEqual(
      stub.requests.map((request) => request.path),
      [SIGN_TRANSACTION_PATH, SIGN_TRANSACTION_PATH, POLL_PATH],
    );
    assert.equal(stub.requests[0]?.body, stub.requests[1]?.body);
    assert.deepEqual(ctx.messages, []);

    const approval = await setUp();
    approval.stub.answer(
      activity("ACTIVITY_STATUS_CONSENSUS_NEEDED", { type: SIGN_TRANSACTION_TYPE }),
    );
    await assert.rejects(
      approval.adapter.signTransaction?.(transactionRequest(type, eip1559), signContext()) ??
        Promise.resolve(),
      failsWith(
        new RegExp(`Turnkey holds activity ${ACTIVITY_ID} until it gets more approvals`),
        true,
      ),
    );
  });

  it("does not change the bytes it got", async () => {
    const [, , [type, eip1559] = [2, {}]] = TRANSACTIONS;
    const { adapter } = await setUp();
    const request = transactionRequest(type, eip1559);
    const before = { unsigned: request.unsigned.slice(), digest: request.digest.slice() };
    await adapter.signTransaction?.(request, signContext());
    assert.deepEqual(request.unsigned, before.unsigned);
    assert.deepEqual(request.digest, before.digest);
  });

  it("declares that an abandoned transaction may still be signed, in transaction mode only (#537)", async () => {
    const transaction = await setUp(turnkeyKey({ transactionSigning: "transaction" }));
    assert.equal(transaction.adapter.signTransactionOutlivesAbort, true);
    const digest = await setUp(turnkeyKey({ transactionSigning: "digest" }));
    assert.ok(!("signTransactionOutlivesAbort" in digest.adapter));
  });

  it("tells the core right before each sign_transaction attempt leaves, then the activity id (#537)", async () => {
    const [, , [, eip1559] = [2, {}]] = TRANSACTIONS;
    const { stub, adapter } = await setUp();
    // Each entry records how many requests the stub had when the core heard of the next one.
    const ctx = signContext(() => stub.requests.length);
    stub.answer(
      turnkeyError(500),
      activity("ACTIVITY_STATUS_PENDING", { type: SIGN_TRANSACTION_TYPE }),
    );
    stub.pendingPolls = 0;

    await assert.rejects(
      adapter.signTransaction?.(transactionRequest(2, eip1559), ctx) ?? Promise.resolve(),
      // The queued activity is not the stub's own, so the poll finds no such activity.
      /Turnkey answered 404/,
    );

    assert.deepEqual(
      stub.requests.map((request) => request.path),
      [SIGN_TRANSACTION_PATH, SIGN_TRANSACTION_PATH, POLL_PATH],
    );
    assert.deepEqual(ctx.sent, [
      [null, 0],
      [null, 1],
      [ACTIVITY_ID, 2],
    ]);
  });

  it("tells the core nothing when no sign_transaction request leaves (#537)", async () => {
    const [, , [, eip1559] = [2, {}]] = TRANSACTIONS;
    const refused = await setUp();
    const unsupported = signContext();
    await assert.rejects(
      refused.adapter.signTransaction?.(transactionRequest(3, eip1559), unsupported) ??
        Promise.resolve(),
    );
    assert.deepEqual(unsupported.sent, []);

    const aborted = signContext();
    aborted.controller.abort(new Error("cancelled"));
    await assert.rejects(
      refused.adapter.signTransaction?.(transactionRequest(2, eip1559), aborted) ??
        Promise.resolve(),
      /cancelled/,
    );
    assert.deepEqual(aborted.sent, []);

    const badKey = await setUp(turnkeyKey({}, { privateKey: "00" }));
    const failed = signContext();
    await assert.rejects(
      badKey.adapter.signTransaction?.(transactionRequest(2, eip1559), failed) ?? Promise.resolve(),
      /is not a P-256 private key/,
    );
    assert.deepEqual(failed.sent, []);
    assert.equal(refused.stub.requests.length + badKey.stub.requests.length, 0);
  });

  it("has no signTransaction with transactionSigning digest, and signs digests as before", async () => {
    const { stub, adapter } = await setUp(turnkeyKey({ transactionSigning: "digest" }));
    assert.ok(!("signTransaction" in adapter));
    await sign(adapter, "digest");
    assert.equal(stub.bodies(SIGN_TRANSACTION_PATH).length, 0);
    assert.equal(stub.bodies(SIGN_PATH).length, 1);

    const transaction = await setUp(turnkeyKey({ transactionSigning: "transaction" }));
    assert.ok("signTransaction" in transaction.adapter);
    assert.equal(typeof Reflect.get(transaction.adapter, "signTransaction"), "function");
  });
});
