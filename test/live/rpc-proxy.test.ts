// The proxy between the anvil fork and the Sepolia RPC, against a fake upstream. Runs offline, in
// `pnpm test`.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

import {
  isForwardedMethod,
  parseRequests,
  type RecordingProxy,
  startRecordingProxy,
} from "./helpers/rpc-proxy.ts";

/** A JSON-RPC server that answers every call with its method name and records what it got. */
async function fakeUpstream(): Promise<{
  server: Server;
  url: string;
  received: string[];
  bodies: string[];
}> {
  const received: string[] = [];
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      bodies.push(body);
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
  return { server, url: `http://127.0.0.1:${address.port}`, received, bodies };
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

  it("forwards only the reads on the allow-list", () => {
    for (const method of [
      "eth_sendRawTransaction",
      "eth_sendTransaction",
      "eth_sendRawTransactionSync",
      "eth_sendBundle",
      "eth_callBundle",
      "mev_simBundle",
      "mev_sendBundle",
      "trace_rawTransaction",
      "personal_sendTransaction",
      "wallet_sendCalls",
      "eth_submitWork",
      "eth_getbalance",
      "",
    ]) {
      assert.ok(!isForwardedMethod(method), method);
    }
    for (const method of [
      "eth_chainId",
      "anvil_nodeInfo",
      "eth_getBalance",
      "eth_getAccountInfo",
      "eth_getStorageAt",
      "eth_call",
      "eth_getTransactionByHash",
      "eth_getBlockByNumber",
      "debug_traceTransaction",
    ]) {
      assert.ok(isForwardedMethod(method), method);
    }
  });

  it("rebuilds each request from the fields it checked", () => {
    const parsed = parseRequests(
      '{"jsonrpc":"2.0","id":7,"method":"eth_sendRawTransaction","method":"eth_chainId","params":[]}',
    );
    assert.deepEqual(parsed, {
      batch: false,
      calls: [{ jsonrpc: "2.0", id: 7, method: "eth_chainId", params: [] }],
    });
    assert.equal(
      parseRequests(
        '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","Method":"eth_sendRawTransaction"}',
      ),
      undefined,
    );
    assert.equal(parseRequests('{"id":1,"method":"eth_chainId","params":"0x1"}'), undefined);
    assert.deepEqual(
      parseRequests('{"method":"anvil_nodeInfo","params":null,"id":1,"jsonrpc":"2.0"}'),
      {
        batch: false,
        calls: [{ jsonrpc: "2.0", id: 1, method: "anvil_nodeInfo", params: null }],
      },
    );
  });

  it("forwards reads and batches, and records each method and its params", async () => {
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
    assert.deepEqual(
      proxy.forwarded().map((item) => item.method),
      ["eth_chainId", "eth_getBalance", "eth_getCode"],
    );
    assert.deepEqual(proxy.refused(), []);
  });

  it("forwards the checked method when the body repeats the method key", async () => {
    const forwarded = upstream.bodies.length;
    const answer = await post(
      proxy.url,
      '{"jsonrpc":"2.0","id":9,"method":"eth_sendRawTransaction","method":"eth_chainId","params":[]}',
    );
    assert.deepEqual(answer.json, { jsonrpc: "2.0", id: 9, result: "eth_chainId" });
    assert.deepEqual(upstream.bodies.slice(forwarded), [
      '{"jsonrpc":"2.0","id":9,"method":"eth_chainId","params":[]}',
    ]);
  });

  it("refuses a key that a case-insensitive decoder would read as method", async () => {
    const forwarded = upstream.received.length;
    const answer = await post(
      proxy.url,
      '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","Method":"eth_sendRawTransaction","params":[]}',
    );
    assert.equal(answer.status, 400);
    assert.equal(upstream.received.length, forwarded, "the request reached the upstream");
  });

  it("refuses any method off the list, alone or in a batch, without forwarding any of it", async () => {
    const forwarded = upstream.received.length;
    const refusedBefore = proxy.refused().length;
    const single = await post(proxy.url, call(4, "eth_sendRawTransaction"));
    assert.equal(single.status, 200);
    assert.match(JSON.stringify(single.json), /refused by the live suite's proxy/);
    const batch = await post(proxy.url, [call(5, "eth_getBalance"), call(6, "eth_callBundle")]);
    assert.ok(Array.isArray(batch.json) && batch.json.length === 2);
    for (const method of ["mev_simBundle", "trace_rawTransaction", "wallet_sendCalls"]) {
      await post(proxy.url, call(7, method));
    }
    assert.equal(upstream.received.length, forwarded, "a refused request reached the upstream");
    assert.deepEqual(proxy.refused().slice(refusedBefore), [
      "not on the read allow-list: eth_sendRawTransaction",
      "not on the read allow-list: eth_callBundle",
      "not on the read allow-list: mev_simBundle",
      "not on the read allow-list: trace_rawTransaction",
      "not on the read allow-list: wallet_sendCalls",
    ]);
    assert.equal(proxy.methods().get("eth_sendRawTransaction"), 1);
  });

  it("refuses a read that carries 65 bytes of hex or more", async () => {
    const forwarded = upstream.received.length;
    const raw = `0x02f8${"ab".repeat(100)}`;
    const answer = await post(proxy.url, {
      jsonrpc: "2.0",
      id: 8,
      method: "eth_call",
      params: [{ data: raw }, "latest"],
    });
    assert.match(JSON.stringify(answer.json), /65 bytes of hex or more/);
    const bare = await post(proxy.url, {
      jsonrpc: "2.0",
      id: 9,
      method: "eth_getLogs",
      params: [{ topics: ["ab".repeat(65)] }],
    });
    assert.match(JSON.stringify(bare.json), /65 bytes of hex or more/);
    assert.equal(upstream.received.length, forwarded);
  });

  it("refuses a body that is not JSON-RPC", async () => {
    const forwarded = upstream.received.length;
    const refusedBefore = proxy.refused().length;
    for (const body of ["not json", "[]", "{}", JSON.stringify([{ method: 1 }]), "[1]"]) {
      const answer = await post(proxy.url, body);
      assert.equal(answer.status, 400, body);
    }
    assert.equal(upstream.received.length, forwarded);
    assert.deepEqual(proxy.refused().slice(refusedBefore), Array(5).fill("not JSON-RPC"));
  });
});
