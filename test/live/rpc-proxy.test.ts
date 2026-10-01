// The proxy between the anvil fork and the Sepolia RPC, against a fake upstream. Runs offline, in
// `pnpm test`.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

import { isSendMethod, type RecordingProxy, startRecordingProxy } from "./helpers/rpc-proxy.ts";

/** A JSON-RPC server that answers every call with its method name and records what it got. */
async function fakeUpstream(): Promise<{ server: Server; url: string; received: string[] }> {
  const received: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed: unknown = JSON.parse(body);
      const calls: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      const answers = calls.map((call) => {
        const method = String(Reflect.get(Object(call), "method"));
        received.push(method);
        const id: unknown = Reflect.get(Object(call), "id");
        return { jsonrpc: "2.0", id, result: method };
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(Array.isArray(parsed) ? answers : answers[0]));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}`, received };
}

async function post(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text === "" ? undefined : JSON.parse(text) };
}

const call = (id: number, method: string): unknown => ({ jsonrpc: "2.0", id, method, params: [] });

describe("live test RPC proxy", () => {
  let upstream: Awaited<ReturnType<typeof fakeUpstream>>;
  let proxy: RecordingProxy;

  before(async () => {
    upstream = await fakeUpstream();
    proxy = await startRecordingProxy(upstream.url);
  });

  after(async () => {
    await proxy.close();
    upstream.server.close();
  });

  it("knows which methods broadcast", () => {
    for (const method of [
      "eth_sendRawTransaction",
      "eth_sendTransaction",
      "eth_sendRawTransactionSync",
      "eth_sendBundle",
      "eth_submitWork",
      "mev_sendBundle",
    ]) {
      assert.ok(isSendMethod(method), method);
    }
    for (const method of [
      "eth_getBalance",
      "eth_call",
      "eth_getTransactionByHash",
      "eth_getBlockByNumber",
    ]) {
      assert.ok(!isSendMethod(method), method);
    }
  });

  it("forwards reads and batches, and records each method", async () => {
    const single = await post(proxy.url, call(1, "eth_chainId"));
    assert.equal(single.status, 200);
    assert.deepEqual(single.json, { jsonrpc: "2.0", id: 1, result: "eth_chainId" });
    const batch = await post(proxy.url, [call(2, "eth_getBalance"), call(3, "eth_getCode")]);
    assert.deepEqual(batch.json, [
      { jsonrpc: "2.0", id: 2, result: "eth_getBalance" },
      { jsonrpc: "2.0", id: 3, result: "eth_getCode" },
    ]);
    assert.deepEqual(upstream.received, ["eth_chainId", "eth_getBalance", "eth_getCode"]);
    assert.equal(proxy.methods().get("eth_getBalance"), 1);
    assert.deepEqual(proxy.refused(), []);
  });

  it("refuses a send, alone or in a batch, without forwarding any of it", async () => {
    const forwarded = upstream.received.length;
    const single = await post(proxy.url, call(4, "eth_sendRawTransaction"));
    assert.equal(single.status, 200);
    assert.match(JSON.stringify(single.json), /refused by the live suite's proxy/);
    const batch = await post(proxy.url, [
      call(5, "eth_getBalance"),
      call(6, "eth_sendTransaction"),
    ]);
    assert.ok(Array.isArray(batch.json) && batch.json.length === 2);
    assert.equal(upstream.received.length, forwarded, "a refused request reached the upstream");
    assert.deepEqual(proxy.refused(), ["eth_sendRawTransaction", "eth_sendTransaction"]);
    assert.equal(proxy.methods().get("eth_sendRawTransaction"), 1);
  });

  it("refuses a body that is not JSON-RPC", async () => {
    const forwarded = upstream.received.length;
    for (const body of ["not json", "[]", "{}", JSON.stringify([{ method: 1 }])]) {
      const answer = await post(proxy.url, body);
      assert.equal(answer.status, 400, body);
    }
    assert.equal(upstream.received.length, forwarded);
    assert.equal(proxy.refused().filter((item) => item === "<unparsable>").length, 4);
  });
});
