// The Transaction Service client with an injected fetch: what it sends, and how each answer maps to
// a catalogue error that shows neither the API key nor the service's text beyond the allow-list.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Address, Hex } from "viem";

import { safeTransaction } from "../../src/internal/safe-tx.ts";
import {
  isServiceUrl,
  proposalBody,
  refusalReasons,
  TransactionServiceClient,
  type ProposalBody,
} from "../../src/internal/tx-service.ts";

const SAFE: Address = "0x2B0b9cBDA3D7b0F760187c52A8FFB18C48E5d96A";
const SENDER: Address = "0x79613FD49472C3C7a32188e45ff00e7bdC8a897d";
const KEY = "sk-test-not-a-secret";
const HASH: Hex = `0x${"11".repeat(32)}`;
const SIGNATURE: Hex = `0x${"22".repeat(64)}1b`;

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fetch that records each call and answers from a list. */
function recorder(
  answers: (Response | Error | ((init: RequestInit | undefined) => Promise<Response>))[],
): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : input.toString(), init });
    const answer = answers.shift();
    if (answer === undefined) {
      throw new Error("no answer left");
    }
    if (answer instanceof Error) {
      throw answer;
    }
    return answer instanceof Response ? answer : await answer(init);
  };
  return { fetch, calls };
}

const json = (status: number, body: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

const body: ProposalBody = proposalBody(
  safeTransaction({ to: SENDER, value: 5n, data: "0x1234" }, 7n),
  HASH,
  SENDER,
  SIGNATURE,
  "hardhat-kms",
);

function headersOf(call: Call | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(call?.init?.headers).entries());
}

/** A fetch that answers only by failing when its signal aborts. */
const hang = async (init: RequestInit | undefined): Promise<Response> =>
  await new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("aborted", "AbortError"));
    });
  });

describe("TransactionServiceClient", () => {
  it("asks for the highest queued nonce as api-kit's getPendingTransactions does", async () => {
    const { fetch, calls } = recorder([json(200, { count: 1, results: [{ nonce: "12" }] })]);
    const client = new TransactionServiceClient({
      url: "https://service.test//",
      apiKey: KEY,
      fetch,
    });
    assert.equal(client.url, "https://service.test");
    assert.equal(await client.highestQueuedNonce(SAFE, 10n), 12n);
    assert.equal(
      calls[0]?.url,
      `https://service.test/api/v2/safes/${SAFE}/multisig-transactions/?executed=false&nonce__gte=10&ordering=-nonce&limit=1`,
    );
    assert.equal(calls[0]?.init?.method, "GET");
    assert.equal(calls[0]?.init?.redirect, "manual");
    assert.ok(calls[0]?.init?.signal instanceof AbortSignal);
    assert.equal(calls[0]?.init?.body, undefined);
    assert.deepEqual(headersOf(calls[0]), {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${KEY}`,
    });
  });

  it("reads numbers and strings as nonces, and an empty list as nothing queued", async () => {
    const { fetch } = recorder([
      json(200, { results: [{ nonce: 3 }] }),
      json(200, { results: [] }),
    ]);
    const client = new TransactionServiceClient({ url: "http://127.0.0.1:1", fetch });
    assert.equal(await client.highestQueuedNonce(SAFE, 0n), 3n);
    assert.equal(await client.highestQueuedNonce(SAFE, 0n), undefined);
  });

  it("refuses a list it cannot read", async () => {
    for (const answer of [
      json(200, { results: "no" }),
      json(200, { results: [{ nonce: "-1" }] }),
      json(200, { results: [{ nonce: 1.5 }] }),
      json(200, { results: [{}] }),
      json(200, { results: [null] }),
      json(200, null),
      new Response("not json", { status: 200 }),
      new Response("", { status: 200 }),
    ]) {
      const { fetch } = recorder([answer]);
      const client = new TransactionServiceClient({ url: "http://localhost:1", fetch });
      await assert.rejects(
        client.highestQueuedNonce(SAFE, 0n),
        /answered the list of queued transactions with a body the plugin cannot read/,
      );
    }
  });

  it("posts the body as JSON, without an Authorization header when there is no key", async () => {
    const { fetch, calls } = recorder([new Response(null, { status: 201 })]);
    const client = new TransactionServiceClient({ url: "https://service.test", apiKey: "", fetch });
    await client.propose(SAFE, body);
    assert.equal(calls[0]?.url, `https://service.test/api/v2/safes/${SAFE}/multisig-transactions/`);
    assert.equal(calls[0]?.init?.method, "POST");
    assert.equal(calls[0]?.init?.body, JSON.stringify(body));
    assert.deepEqual(headersOf(calls[0]), {
      accept: "application/json",
      "content-type": "application/json",
    });
    assert.deepEqual(body, {
      to: SENDER,
      value: "5",
      data: "0x1234",
      operation: 0,
      safeTxGas: "0",
      baseGas: "0",
      gasPrice: "0",
      gasToken: "0x0000000000000000000000000000000000000000",
      refundReceiver: "0x0000000000000000000000000000000000000000",
      nonce: 7,
      contractTransactionHash: HASH,
      sender: SENDER,
      signature: SIGNATURE,
      origin: "hardhat-kms",
    });
    assert.equal(
      "origin" in
        proposalBody(safeTransaction({ to: SENDER }, 0n), HASH, SENDER, SIGNATURE, undefined),
      false,
    );
  });

  const cases: { status: number; body?: string; message: RegExp; signed: RegExp }[] = [
    {
      status: 401,
      message: /answered 401 to the proposal: it did not accept the API key/,
      signed: /did not store it/,
    },
    {
      status: 403,
      message: /answered 403 to the proposal: it did not accept the API key/,
      signed: /did not store it/,
    },
    {
      status: 422,
      body: JSON.stringify({
        nonFieldErrors: ["Signer=0x1 is not an owner\u001b[31m", 7, "b"],
        message: "m",
        signature: ["x"],
        "bad key!": ["y"],
        detail: "hidden",
      }),
      message:
        /refused the proposal with 422: Signer=0x1 is not an owner\?\[31m; b; m; refused fields: signature\./,
      signed: /did not store it/,
    },
    {
      status: 400,
      body: "<html>",
      message: /refused the proposal with 400: no reason given/,
      signed: /did not store it/,
    },
    {
      status: 422,
      body: "[1]",
      message: /refused the proposal with 422: no reason given/,
      signed: /did not store it/,
    },
    {
      status: 429,
      message: /answered 429 to the proposal: the API key's rate limit or quota is used up/,
      signed: /did not store it/,
    },
    {
      status: 500,
      message: /answered 500 to the proposal\. It may be down or overloaded/,
      signed: /check the Safe app/,
    },
    { status: 503, message: /answered 503 to the proposal/, signed: /check the Safe app/ },
    {
      status: 302,
      message: /answered 302 to the proposal, which the plugin does not expect/,
      signed: /check the Safe app/,
    },
    {
      status: 404,
      message: /answered 404 to the proposal, which the plugin does not expect/,
      signed: /did not store it/,
    },
  ];
  for (const testCase of cases) {
    it(`maps ${testCase.status} on a proposal to its catalogue error`, async () => {
      const { fetch } = recorder([
        new Response(testCase.body ?? `{"detail":"${KEY} leaked"}`, { status: testCase.status }),
      ]);
      const client = new TransactionServiceClient({
        url: "https://service.test",
        apiKey: KEY,
        fetch,
      });
      await assert.rejects(client.propose(SAFE, body), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, testCase.message);
        assert.match(error.message, testCase.signed);
        assert.doesNotMatch(error.message, new RegExp(KEY));
        assert.doesNotMatch(error.message, /hidden|leaked|html/);
        return true;
      });
    });
  }

  it("says nothing was signed when a lookup fails", async () => {
    const { fetch } = recorder([json(401, {})]);
    const client = new TransactionServiceClient({ url: "https://service.test", fetch });
    await assert.rejects(client.highestQueuedNonce(SAFE, 0n), /Nothing was signed/);
  });

  it("reports a failed request by its system error code only", async () => {
    const { fetch } = recorder([
      new TypeError("fetch failed https://service.test/?k=secret", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      }),
      new TypeError("fetch failed", { cause: { code: "not a code" } }),
      new TypeError("fetch failed"),
    ]);
    const client = new TransactionServiceClient({ url: "https://service.test", fetch });
    await assert.rejects(client.propose(SAFE, body), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /did not answer the proposal \(ECONNREFUSED\)\. The key signed/);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
    await assert.rejects(
      client.propose(SAFE, body),
      /did not answer the proposal\. The key signed/,
    );
    await assert.rejects(
      client.highestQueuedNonce(SAFE, 0n),
      /did not answer the list of queued transactions\. Nothing was signed/,
    );
  });

  it("stops a request at timeoutMs, and when the caller's signal aborts", async () => {
    const { fetch } = recorder([hang, hang]);
    const client = new TransactionServiceClient({
      url: "https://service.test",
      fetch,
      timeoutMs: 20,
    });
    await assert.rejects(client.propose(SAFE, body), /did not answer the proposal within 20 ms/);
    const controller = new AbortController();
    const slow = new TransactionServiceClient({
      url: "https://service.test",
      fetch,
      timeoutMs: 60_000,
    });
    const pending = slow.highestQueuedNonce(SAFE, 0n, controller.signal);
    controller.abort();
    await assert.rejects(
      pending,
      /did not answer the list of queued transactions\. Nothing was signed/,
    );
  });

  it("uses the global fetch by default", async () => {
    const realFetch = globalThis.fetch;
    const { fetch, calls } = recorder([json(200, { results: [] })]);
    globalThis.fetch = fetch;
    try {
      await new TransactionServiceClient({ url: "https://service.test" }).highestQueuedNonce(
        SAFE,
        0n,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(calls.length, 1);
  });

  it("accepts https, and http only for localhost", () => {
    for (const url of [
      "https://api.safe.global/tx-service/sep",
      "http://127.0.0.1:8000",
      "http://localhost",
      "http://[::1]:8000",
    ]) {
      assert.equal(isServiceUrl(url), true, url);
    }
    for (const url of [
      "http://api.safe.global/tx-service/sep",
      "ftp://service.test",
      "https://user:pass@service.test",
      "https://service.test/?a=1",
      "https://service.test/#x",
      "https://service.test/?",
      "not a url",
    ]) {
      assert.equal(isServiceUrl(url), false, url);
      assert.throws(() => new TransactionServiceClient({ url }), /must be an https URL/);
    }
  });

  it("redacts the API key if the service echoes it in a reason", async () => {
    const { fetch } = recorder([
      json(422, { nonFieldErrors: [`bad key ${KEY}`], message: `key=${KEY}` }),
    ]);
    const client = new TransactionServiceClient({
      url: "https://service.test",
      apiKey: KEY,
      fetch,
    });
    await assert.rejects(client.propose(SAFE, body), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(KEY));
      assert.match(error.message, /bad key <redacted>; key=<redacted>/);
      return true;
    });
  });

  it("reads at most 1 MiB of an answer", async () => {
    const big = JSON.stringify({ results: [{ nonce: "1" }], pad: "x".repeat(1024 * 1024) });
    const { fetch } = recorder([new Response(big, { status: 200 })]);
    const client = new TransactionServiceClient({ url: "https://service.test", fetch });
    await assert.rejects(
      client.highestQueuedNonce(SAFE, 0n),
      /answered the list of queued transactions with a body the plugin cannot read/,
    );
  });

  it("lists allow-listed reasons only", () => {
    assert.equal(refusalReasons(undefined), "no reason given");
    assert.equal(refusalReasons({ nonFieldErrors: "not a list" }), "no reason given");
    assert.equal(refusalReasons({ nonFieldErrors: ["x".repeat(400)] }), `${"x".repeat(300)}…`);
  });
});
