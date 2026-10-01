// The send lock, the nonce high-water mark and the retry cache, through the network hook's
// handlers with a fake node, fake KMS adapters and fake timers.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { keccak_256 } from "@noble/hashes/sha3.js";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { NetworkConnection } from "hardhat/types/network";
import type { JsonRpcRequest, JsonRpcResponse } from "hardhat/types/providers";
import { Transaction } from "micro-eth-signer";

import hardhatKms from "../../../src/index.ts";
import { createNetworkHandlers } from "../../../src/internal/hook-handlers/network.ts";
import { RETRY_TTL_MS, sendLocksInUse } from "../../../src/internal/rpc/send-guard.ts";
import type { KmsKeyUserConfig } from "../../../src/types.ts";
import { fakeAdapter } from "../../helpers/fake-adapter.ts";
import { fakeTimers } from "../../helpers/fake-timers.ts";
import { COW_ACCOUNT, HARDHAT_ACCOUNT_0 } from "../../helpers/vectors.ts";

const COW = COW_ACCOUNT.address;
const ZERO = HARDHAT_ACCOUNT_0.address;
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SECRETS: Record<string, string> = {
  cow: COW_ACCOUNT.secretKey,
  zero: HARDHAT_ACCOUNT_0.secretKey,
};

/** A promise and the function that resolves it. */
function gate(): { promise: Promise<void>; open: () => void } {
  const control: { open: () => void } = { open: () => {} };
  const promise = new Promise<void>((resolve) => {
    control.open = resolve;
  });
  return { promise, open: () => control.open() };
}

/** Lets pending promise callbacks and I/O callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const nonceOf = (raw: string): bigint => Transaction.fromHex(raw, false).raw.nonce;
const hashOf = (raw: string): string =>
  `0x${Buffer.from(keccak_256(Buffer.from(raw.slice(2), "hex"))).toString("hex")}`;

/** What the fake node does with a raw transaction, after recording it. */
type RawHandler = (raw: string, request: JsonRpcRequest) => Promise<JsonRpcResponse>;

/**
 * The network hook's handlers with fake timers, a runtime with two third-party keys (cow, zero),
 * and a fake node. The network sets a fixed gas and gas price, so a fill only reads the chain id
 * and the pending count.
 */
async function setUp(type: "http" | "edr-simulated" = "http") {
  const keys = Object.fromEntries(
    Object.keys(SECRETS).map((name) => {
      const key: unknown = { provider: "myvault", name };
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a third-party provider's key
      return [name, key as KmsKeyUserConfig];
    }),
  );
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKms],
    kms: { keys },
    networks: {
      remote: {
        type: "http",
        url: "http://127.0.0.1:1",
        chainId: 31337,
        gas: 21_000,
        gasPrice: 1,
        kmsAccounts: ["cow", "zero"],
      },
    },
  });
  const state = {
    /** Awaited before each signature, by key name. */
    beforeSign: undefined as ((name: string) => Promise<void>) | undefined,
    signatures: 0,
    closed: 0,
  };
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async (_context, key) => {
      const secret = SECRETS[key.name];
      assert.ok(secret !== undefined);
      const adapter = fakeAdapter({
        secretKey: new Uint8Array(Buffer.from(secret, "hex")),
        beforeSign: async () => {
          state.signatures++;
          await state.beforeSign?.(key.name);
        },
      });
      return {
        ...adapter,
        close: async () => {
          state.closed++;
          await Promise.resolve();
        },
      };
    },
  });

  const node = {
    /** The pending count the node reports for every address. */
    pending: 0n,
    raw: [] as string[],
    onRaw: undefined as RawHandler | undefined,
    methods: [] as string[],
  };
  const answer = async (request: JsonRpcRequest): Promise<JsonRpcResponse> => {
    node.methods.push(request.method);
    const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id: request.id, result });
    switch (request.method) {
      case "eth_chainId":
        return ok("0x7a69");
      case "eth_getTransactionCount":
        return ok(`0x${node.pending.toString(16)}`);
      case "eth_sendRawTransaction": {
        const [raw]: unknown[] = Array.isArray(request.params) ? request.params : [];
        assert.ok(typeof raw === "string");
        node.raw.push(raw);
        return node.onRaw === undefined ? ok(hashOf(raw)) : await node.onRaw(raw, request);
      }
      default:
        throw new Error(`the fake node does not answer ${request.method}`);
    }
  };

  const timers = fakeTimers();
  const handlers = createNetworkHandlers(timers);
  const { remote } = hre.config.networks;
  assert.ok(remote);
  const networkConfig = type === "http" ? remote : { ...remote, type };

  const open = async (): Promise<NetworkConnection<string>> => {
    const provider = {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        const response = await answer({ jsonrpc: "2.0", id: 0, method, params: params ?? [] });
        if ("error" in response) {
          throw new Error(response.error.message);
        }
        return response.result;
      },
    };
    const connection = {
      networkName: "remote",
      networkConfig,
      provider,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the fields the hook reads
    } as NetworkConnection<string>;
    assert.ok(handlers.newConnection);
    return await handlers.newConnection(hre, async () => await Promise.resolve(connection));
  };
  const close = async (connection: NetworkConnection<string>): Promise<void> => {
    assert.ok(handlers.closeConnection);
    await handlers.closeConnection(hre, connection, async () => {});
  };
  let id = 1;
  const request = async (
    connection: NetworkConnection<string>,
    method: string,
    tx: Record<string, unknown>,
  ): Promise<JsonRpcResponse> => {
    assert.ok(handlers.onRequest);
    return await handlers.onRequest(
      hre,
      connection,
      { jsonrpc: "2.0", id: id++, method, params: [tx] },
      async (_context, _connection, next) => await answer(next),
    );
  };
  const send = async (connection: NetworkConnection<string>, tx: Record<string, unknown>) =>
    await request(connection, "eth_sendTransaction", tx);
  return { node, state, timers, open, close, send, request };
}

/** The result of a successful response. */
function resultOf(response: JsonRpcResponse): unknown {
  assert.ok("result" in response, JSON.stringify(response));
  return response.result;
}

/** The error of a failed response. */
function errorOf(response: JsonRpcResponse) {
  assert.ok("error" in response, JSON.stringify(response));
  return response.error;
}

describe("the send lock", () => {
  it("gives N parallel sends from one account consecutive nonces", async () => {
    const { node, open, send } = await setUp();
    const connection = await open();
    // The node never counts the sent transactions as pending, so only the lock and the
    // high-water mark keep the nonces apart.
    const hashes = await Promise.all(
      Array.from({ length: 10 }, async () =>
        resultOf(await send(connection, { from: COW, to: TO })),
      ),
    );
    assert.deepEqual(
      node.raw.map(nonceOf),
      Array.from({ length: 10 }, (_, i) => BigInt(i)),
    );
    assert.deepEqual(hashes, node.raw.map(hashOf));
    assert.equal(sendLocksInUse(), 0);
  });

  it("does not make another account wait", async () => {
    const { node, state, open, send } = await setUp();
    const connection = await open();
    const held = gate();
    state.beforeSign = async (name) => {
      if (name === "cow") {
        await held.promise;
      }
    };
    const cow = send(connection, { from: COW, to: TO });
    await settle();
    // cow holds its lock while its KMS signature hangs; zero signs and sends meanwhile.
    resultOf(await send(connection, { from: ZERO, to: TO }));
    assert.equal(node.raw.length, 1);
    assert.equal(Transaction.fromHex(node.raw[0] ?? "", false).sender, ZERO);
    held.open();
    resultOf(await cow);
    assert.equal(node.raw.length, 2);
  });

  it("lets eth_signTransaction run while a send holds the lock, and leaves the mark alone", async () => {
    const { node, open, send, request } = await setUp();
    const connection = await open();
    resultOf(await send(connection, { from: COW, to: TO }));
    const held = gate();
    node.onRaw = async (raw) => {
      await held.promise;
      return { jsonrpc: "2.0", id: 1, result: hashOf(raw) };
    };
    const sending = send(connection, { from: COW, to: TO });
    await settle();
    assert.equal(node.raw.length, 2, "the second send is broadcasting, holding the lock");
    const signed = resultOf(
      await request(connection, "eth_signTransaction", { from: COW, to: TO }),
    );
    assert.ok(typeof signed === "string");
    assert.equal(nonceOf(signed), 0n, "the node's pending count, not the high-water mark");
    held.open();
    resultOf(await sending);
    assert.deepEqual(node.raw.map(nonceOf), [0n, 1n]);
  });

  it("does not hold the signer while broadcasting, so the idle close can run", async () => {
    const { node, state, timers, open, close, send } = await setUp();
    const connection = await open();
    const held = gate();
    node.onRaw = async (raw) => {
      await held.promise;
      return { jsonrpc: "2.0", id: 1, result: hashOf(raw) };
    };
    const sending = send(connection, { from: COW, to: TO });
    await settle();
    assert.equal(node.raw.length, 1, "broadcasting");
    await close(connection);
    timers.fire();
    await settle();
    assert.equal(state.closed, 2, "the idle close did not wait for the node");
    held.open();
    assert.equal(resultOf(await sending), hashOf(node.raw[0] ?? ""));
  });
});

describe("the nonce high-water mark", () => {
  it("never reuses a nonce on a node whose pending count lags, and follows a node ahead", async () => {
    const { node, open, send } = await setUp();
    const connection = await open();
    await send(connection, { from: COW, to: TO });
    await send(connection, { from: COW, to: TO });
    node.pending = 5n;
    await send(connection, { from: COW, to: TO });
    assert.deepEqual(node.raw.map(nonceOf), [0n, 1n, 5n]);
  });

  it("honours the caller's nonce, which also raises the mark", async () => {
    const { node, open, send } = await setUp();
    const connection = await open();
    await send(connection, { from: COW, to: TO, nonce: "0x7" });
    await send(connection, { from: COW, to: TO });
    await send(connection, { from: COW, to: TO, nonce: "0x2" });
    await send(connection, { from: COW, to: TO });
    assert.deepEqual(node.raw.map(nonceOf), [7n, 8n, 2n, 9n]);
  });

  it("is kept per connection", async () => {
    const { node, open, send } = await setUp();
    await send(await open(), { from: COW, to: TO });
    await send(await open(), { from: COW, to: TO });
    assert.deepEqual(node.raw.map(nonceOf), [0n, 0n]);
  });

  it("is off on a simulated network, whose pending count is authoritative", async () => {
    const { node, open, send } = await setUp("edr-simulated");
    const connection = await open();
    await send(connection, { from: COW, to: TO });
    await send(connection, { from: COW, to: TO });
    assert.deepEqual(node.raw.map(nonceOf), [0n, 0n]);
  });

  it("does not move when signing fails, so the next send gets the same nonce", async () => {
    const { node, state, open, send } = await setUp();
    const connection = await open();
    await send(connection, { from: COW, to: TO });
    state.beforeSign = async () => {
      await Promise.resolve();
      throw new Error("KMS unavailable");
    };
    await assert.rejects(send(connection, { from: COW, to: TO }));
    assert.equal(node.raw.length, 1, "nothing was broadcast");
    state.beforeSign = undefined;
    await send(connection, { from: COW, to: TO });
    assert.deepEqual(node.raw.map(nonceOf), [0n, 1n]);
    assert.equal(sendLocksInUse(), 0);
  });
});

describe("failures after the broadcast", () => {
  it("answer -32000 with the hash, keep the mark, and quote the node's answer", async () => {
    const { node, open, send } = await setUp();
    const connection = await open();
    node.onRaw = async () =>
      await Promise.resolve({
        jsonrpc: "2.0" as const,
        id: 1,
        error: { code: -32003, message: "insufficient funds for gas * price + value" },
      });
    const error = errorOf(await send(connection, { from: COW, to: TO }));
    const hash = hashOf(node.raw[0] ?? "");
    assert.equal(error.code, -32000);
    assert.deepEqual(error.data, { hash });
    assert.ok(error.message.includes(hash), error.message);
    assert.match(error.message, /the node answered -32003: insufficient funds/);
    node.onRaw = undefined;
    await send(connection, { from: COW, to: TO, value: "0x1" });
    assert.deepEqual(node.raw.map(nonceOf), [0n, 0n], "a refused nonce is not skipped");
  });

  it("name only the class of a thrown error, whose text can hold the node's URL", async () => {
    const { node, open, send } = await setUp();
    const connection = await open();
    node.onRaw = async () => {
      await Promise.resolve();
      throw new TypeError("fetch failed: https://rpc.example/v2/SECRET-API-KEY");
    };
    const error = errorOf(await send(connection, { from: COW, to: TO }));
    assert.equal(error.code, -32000);
    assert.match(error.message, /TypeError was thrown/);
    assert.ok(!error.message.includes("SECRET"), error.message);
  });
});

/** Makes the next broadcast fail after the node got the bytes. */
function failOnce(node: { onRaw: RawHandler | undefined }): void {
  node.onRaw = async () => {
    node.onRaw = undefined;
    return await Promise.resolve({
      jsonrpc: "2.0" as const,
      id: 1,
      error: { code: -32000, message: "upstream timeout" },
    });
  };
}

describe("the retry cache", () => {
  it("sends the same bytes again for a retry of the same request, and returns the same hash", async () => {
    const { node, state, open, send } = await setUp();
    const connection = await open();
    failOnce(node);
    const first = errorOf(await send(connection, { from: COW, to: TO, value: "0x1" }));
    // The same params, with the keys in another order.
    const retried = resultOf(await send(connection, { value: "0x1", to: TO, from: COW }));
    assert.deepEqual(first.data, { hash: retried });
    assert.equal(node.raw.length, 2);
    assert.equal(node.raw[0], node.raw[1], "the same bytes");
    assert.equal(state.signatures, 1, "nothing was filled or signed again");
    // The entry was consumed; the retry's success raised the mark.
    await send(connection, { from: COW, to: TO, value: "0x1" });
    assert.equal(state.signatures, 2);
    assert.deepEqual(node.raw.map(nonceOf), [0n, 0n, 1n]);
  });

  it("counts 'already known' as success when it sends the bytes again", async () => {
    const { node, open, send } = await setUp();
    const connection = await open();
    for (const [index, answer] of ["already known", "thrown: Known transaction: 0x12"].entries()) {
      const data = `0x0${index}`;
      failOnce(node);
      const hash = errorOf(await send(connection, { from: COW, to: TO, data })).data;
      node.onRaw = async () => {
        await Promise.resolve();
        if (answer.startsWith("thrown: ")) {
          throw new Error(answer.slice("thrown: ".length));
        }
        return { jsonrpc: "2.0", id: 1, error: { code: -32000, message: answer } };
      };
      const retried = await send(connection, { from: COW, to: TO, data });
      assert.deepEqual({ hash: resultOf(retried) }, hash, answer);
      node.onRaw = undefined;
    }
  });

  it("does not count 'already known' as success on a first send", async () => {
    const { node, open, send } = await setUp();
    const connection = await open();
    node.onRaw = async () =>
      await Promise.resolve({
        jsonrpc: "2.0" as const,
        id: 1,
        error: { code: -32000, message: "already known" },
      });
    assert.equal(errorOf(await send(connection, { from: COW, to: TO })).code, -32000);
  });

  it("keeps the entry when sending again fails too", async () => {
    const { node, state, open, send } = await setUp();
    const connection = await open();
    node.onRaw = async () =>
      await Promise.resolve({
        jsonrpc: "2.0" as const,
        id: 1,
        error: { code: -32000, message: "upstream timeout" },
      });
    for (let i = 0; i < 3; i++) {
      errorOf(await send(connection, { from: COW, to: TO }));
    }
    assert.equal(state.signatures, 1);
    assert.equal(new Set(node.raw).size, 1, "one transaction, sent three times");
  });

  it("is missed by other params, another account and another connection", async () => {
    const { node, state, open, send } = await setUp();
    const connection = await open();
    failOnce(node);
    errorOf(await send(connection, { from: COW, to: TO, value: "0x1" }));
    resultOf(await send(connection, { from: COW, to: TO, value: "0x2" }));
    resultOf(await send(connection, { from: ZERO, to: TO, value: "0x1" }));
    resultOf(await send(await open(), { from: COW, to: TO, value: "0x1" }));
    assert.equal(state.signatures, 4, "each was filled and signed");
    assert.equal(node.raw.length, 4);
  });

  it("expires after 120 s", async () => {
    const { node, state, timers, open, send } = await setUp();
    const connection = await open();
    failOnce(node);
    errorOf(await send(connection, { from: COW, to: TO }));
    assert.deepEqual(timers.delays(), [RETRY_TTL_MS]);
    timers.fire();
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.equal(state.signatures, 2, "filled and signed again");
  });

  it("is dropped when the connection closes", async () => {
    const { node, timers, open, close, send } = await setUp();
    const connection = await open();
    const other = await open();
    failOnce(node);
    errorOf(await send(connection, { from: COW, to: TO }));
    await close(connection);
    assert.equal(timers.pending(), 0, "the entry's timer is cancelled");
    await close(other);
  });

  it("keeps no entry for params it cannot serialize", async () => {
    const { node, state, open, send } = await setUp();
    const connection = await open();
    failOnce(node);
    errorOf(await send(connection, { from: COW, to: TO, extra: new Date(0) }));
    resultOf(await send(connection, { from: COW, to: TO, extra: new Date(0) }));
    assert.equal(state.signatures, 2);
  });
});
