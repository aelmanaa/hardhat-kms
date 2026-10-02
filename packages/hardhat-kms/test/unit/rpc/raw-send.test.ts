// Raw transactions and nonce reads of KMS accounts, through the network hook's handlers with a
// fake node: the send lock, the high-water mark and the pass-through of everything else.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardhatError } from "@nomicfoundation/hardhat-errors";
import type { NetworkConnection } from "hardhat/types/network";
import type { JsonRpcResponse } from "hardhat/types/providers";
import { Transaction } from "micro-eth-signer";

import {
  MAX_SEND_LOCK_WAITERS,
  NONCE_LEASE_MS,
  sendLocksInUse,
} from "../../../src/internal/rpc/send-guard.ts";
import {
  COW,
  errorOf,
  gate,
  hashOf,
  nonceOf,
  refuse,
  resultOf,
  type SendHarness,
  settle,
  setUp,
  TO,
  ZERO,
} from "../../helpers/send-harness.ts";
import { COW_ACCOUNT } from "../../helpers/vectors.ts";

/** Hardhat's second default account, which is not a KMS account here. */
const OTHER_SECRET = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

/** A transfer signed outside the plugin, as a library account and viem sign it. */
function signedRaw(secretKey: string, nonce: bigint, value = 1n): string {
  return Transaction.prepare(
    {
      to: TO,
      nonce,
      chainId: 31337n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      gasLimit: 21_000n,
      value,
    },
    false,
  )
    .signBy(new Uint8Array(Buffer.from(secretKey, "hex")), false)
    .toHex(true);
}

const cowRaw = (nonce: bigint, value = 1n): string =>
  signedRaw(COW_ACCOUNT.secretKey, nonce, value);

/** Opens a connection whose KMS addresses are known, as after `getAccount` or a first send. */
async function openKnown(harness: SendHarness): Promise<NetworkConnection<string>> {
  const connection = await harness.open();
  // The fake node refuses eth_accounts, so the list is the KMS addresses only.
  resultOf((await harness.call(connection, "eth_accounts", [])).response);
  harness.node.methods.length = 0;
  return connection;
}

/** Sends a raw transaction through the hook. */
async function sendRaw(
  harness: SendHarness,
  connection: NetworkConnection<string>,
  raw: unknown,
): Promise<{ response: JsonRpcResponse; params: unknown[]; forwardedParams: unknown[] }> {
  const params = [raw];
  const { response, forwarded } = await harness.call(connection, "eth_sendRawTransaction", params);
  assert.equal(forwarded.length, 1, "exactly one request reached the node");
  const [request] = forwarded;
  assert.ok(request !== undefined);
  assert.equal(request.method, "eth_sendRawTransaction");
  assert.ok(Array.isArray(request.params));
  return { response, params, forwardedParams: request.params };
}

describe("a KMS account's raw transaction", () => {
  it("raises the mark, so the next send through the plugin takes a higher nonce", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const raw = cowRaw(0n);
    const { response, params, forwardedParams } = await sendRaw(harness, connection, raw);
    assert.equal(resultOf(response), hashOf(raw));
    assert.equal(forwardedParams, params, "the request's params go on as they came");
    // The fake node's pending count stays at 0, so only the mark moves the next nonce.
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.deepEqual(node.raw.map(nonceOf), [0n, 1n]);
    assert.equal(sendLocksInUse(), 0);
  });

  it("waits for a send that holds the account's lock, then goes out after it", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const held = gate();
    node.onRaw = async (raw) => {
      await held.promise;
      return { jsonrpc: "2.0", id: 1, result: hashOf(raw) };
    };
    const sending = send(connection, { from: COW, to: TO });
    await settle();
    assert.equal(node.raw.length, 1, "the send is broadcasting, holding the lock");
    const raw = cowRaw(1n);
    const rawSending = sendRaw(harness, connection, raw);
    await settle();
    assert.equal(node.raw.length, 1, "the raw transaction waits for the lock");
    held.open();
    resultOf(await sending);
    resultOf((await rawSending).response);
    assert.deepEqual(node.raw.map(nonceOf), [0n, 1n]);
    assert.equal(sendLocksInUse(), 0);
  });

  it("raises the mark when a re-broadcast gets 'already known', and passes the answer on unchanged", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const raw = cowRaw(0n);
    resultOf((await sendRaw(harness, connection, raw)).response);
    refuse(node, "already known");
    const again = await sendRaw(harness, connection, raw);
    assert.deepEqual(errorOf(again.response), { code: -32000, message: "already known" });
    node.onRaw = undefined;
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.deepEqual(node.raw.map(nonceOf), [0n, 0n, 1n]);
    assert.equal(sendLocksInUse(), 0);
  });

  it("raises the mark when an error answer says it was mined", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const raw = cowRaw(0n);
    node.onRaw = async () =>
      await Promise.resolve({
        jsonrpc: "2.0" as const,
        id: 1,
        error: { code: 3, message: "reverted", data: { transactionHash: hashOf(raw) } },
      });
    errorOf((await sendRaw(harness, connection, raw)).response);
    node.onRaw = undefined;
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.deepEqual(node.raw.map(nonceOf), [0n, 1n]);
  });

  it("leaves the mark alone when the node refuses it", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    refuse(node, "nonce too low");
    assert.equal(
      errorOf((await sendRaw(harness, connection, cowRaw(4n))).response).message,
      "nonce too low",
    );
    node.onRaw = undefined;
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.deepEqual(node.raw.map(nonceOf), [4n, 0n]);
    assert.ok(!node.methods.includes("eth_getTransactionByHash"), "nothing to look up");
  });

  it("rethrows a thrown answer unchanged, and learns from it", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const answer = Object.assign(new Error("already known"), { code: -32000 });
    node.onRaw = async () => {
      await Promise.resolve();
      throw answer;
    };
    await assert.rejects(sendRaw(harness, connection, cowRaw(0n)), (error) => error === answer);
    node.onRaw = undefined;
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.deepEqual(node.raw.map(nonceOf), [0n, 1n]);
  });

  for (const [what, fail] of [
    [
      "no answer",
      async (): Promise<JsonRpcResponse> => {
        await Promise.resolve();
        throw new Error("socket hang up");
      },
    ],
    [
      "a gateway's 'I don't know'",
      async (): Promise<JsonRpcResponse> =>
        await Promise.resolve({
          jsonrpc: "2.0" as const,
          id: 1,
          error: { code: -32603, message: "upstream request timeout" },
        }),
    ],
  ] as const) {
    it(`after ${what}, makes the next send look it up first`, async () => {
      const harness = await setUp();
      const { node, send } = harness;
      const connection = await openKnown(harness);
      const raw = cowRaw(0n);
      node.onRaw = fail;
      const outcome: unknown = await harness.call(connection, "eth_sendRawTransaction", [raw]).then(
        ({ response }) => errorOf(response).message,
        (error: unknown) => error,
      );
      assert.ok(
        outcome === "upstream request timeout" ||
          (outcome instanceof Error && outcome.message === "socket hang up"),
        "the outcome comes back as the node gave it",
      );
      node.onRaw = undefined;
      node.lookUp = (hash) => (hash === hashOf(raw) ? { hash } : null);
      resultOf(await send(connection, { from: COW, to: TO }));
      assert.ok(node.methods.includes("eth_getTransactionByHash"));
      assert.deepEqual(node.raw.map(nonceOf), [0n, 1n], "the node has it, so the mark rose");
    });
  }

  it("passes on unchanged after a refused connection, and keeps nothing", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const refused = new HardhatError(HardhatError.ERRORS.CORE.NETWORK.CONNECTION_REFUSED, {
      network: "remote",
    });
    node.onRaw = async () => {
      await Promise.resolve();
      throw refused;
    };
    await assert.rejects(sendRaw(harness, connection, cowRaw(0n)), (error) => error === refused);
    node.onRaw = undefined;
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.ok(!node.methods.includes("eth_getTransactionByHash"), "nothing to look up");
    assert.deepEqual(node.raw.map(nonceOf), [0n, 0n]);
  });

  it("fails at once, unsent, when made from inside a send from the same account", async () => {
    const harness = await setUp();
    const { node, state, send } = harness;
    const connection = await openKnown(harness);
    let inner: unknown;
    state.beforeSign = async (name) => {
      if (name === "cow" && inner === undefined) {
        inner = await sendRaw(harness, connection, cowRaw(5n)).catch((error: unknown) => error);
      }
    };
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.ok(inner instanceof Error);
    assert.match(
      inner.message,
      new RegExp(`raw transaction from ${COW.toLowerCase()} on chain 31337 was sent from inside`),
    );
    assert.match(inner.message, /so it was not sent/);
    assert.deepEqual(node.raw.map(nonceOf), [0n], "only the outer send reached the node");
    assert.equal(sendLocksInUse(), 0);
  });

  it(`passes on unchanged when ${MAX_SEND_LOCK_WAITERS} requests already wait for the lock`, async () => {
    const harness = await setUp();
    const { node, send, call } = harness;
    const connection = await openKnown(harness);
    const held = gate();
    node.onRaw = async (raw) => {
      await held.promise;
      return { jsonrpc: "2.0", id: 1, result: hashOf(raw) };
    };
    const sending = send(connection, { from: COW, to: TO });
    await settle();
    const reads = Array.from(
      { length: MAX_SEND_LOCK_WAITERS },
      async () => await call(connection, "eth_getTransactionCount", [COW, "pending"]),
    );
    await settle();
    node.onRaw = undefined;
    // The queue is full: the raw transaction goes on at once, without the lock.
    resultOf((await sendRaw(harness, connection, cowRaw(1n))).response);
    assert.equal(node.raw.length, 2);
    held.open();
    resultOf(await sending);
    await Promise.all(reads);
    assert.equal(sendLocksInUse(), 0);
  });
});

describe("a raw transaction that is not a known KMS account's", () => {
  it("passes on unchanged from another sender, with no chain read and no lock", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const raw = signedRaw(OTHER_SECRET, 0n);
    assert.equal(Transaction.fromHex(raw, false).sender, OTHER);
    const { response, params, forwardedParams } = await sendRaw(harness, connection, raw);
    assert.equal(resultOf(response), hashOf(raw));
    assert.equal(forwardedParams, params);
    assert.deepEqual(node.methods, ["eth_sendRawTransaction"]);
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.deepEqual(node.raw.map(nonceOf), [0n, 0n], "cow's mark did not move");
  });

  for (const raw of ["0x1234", "0xzz", "not hex", "0x"]) {
    it(`passes on params it cannot decode (${raw})`, async () => {
      const harness = await setUp();
      const connection = await openKnown(harness);
      const { response, params, forwardedParams } = await sendRaw(harness, connection, raw);
      assert.equal(resultOf(response), hashOf(raw));
      assert.equal(forwardedParams, params);
      assert.deepEqual(harness.node.methods, ["eth_sendRawTransaction"]);
    });
  }

  it("passes on unchanged before the KMS addresses are looked up, with no KMS call", async () => {
    const harness = await setUp();
    const { node, state, send } = harness;
    const connection = await harness.open();
    const { response } = await sendRaw(harness, connection, cowRaw(0n));
    resultOf(response);
    assert.deepEqual(node.methods, ["eth_sendRawTransaction"]);
    assert.equal(state.signatures, 0);
    // Not seen, so not counted: the node's pending count decides the next send's nonce.
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.deepEqual(node.raw.map(nonceOf), [0n, 0n]);
  });
});

describe("a nonce read for a KMS account", () => {
  it("waits for the account's send, and answers at least the mark plus one", async () => {
    const harness = await setUp();
    const { node, send, call } = harness;
    const connection = await openKnown(harness);
    resultOf(await send(connection, { from: COW, to: TO }));
    const held = gate();
    node.onRaw = async (raw) => {
      await held.promise;
      return { jsonrpc: "2.0", id: 1, result: hashOf(raw) };
    };
    const sending = send(connection, { from: COW, to: TO });
    await settle();
    let answered = false;
    const reading = call(connection, "eth_getTransactionCount", [COW, "pending"]).then((read) => {
      answered = true;
      return read;
    });
    await settle();
    assert.equal(answered, false, "the read waits for the send");
    held.open();
    resultOf(await sending);
    // The fake node still counts 0; the mark is 1.
    assert.equal(resultOf((await reading).response), "0x2");
    assert.equal(sendLocksInUse(), 0);
  });

  it("answers the node's count when it is above the mark", async () => {
    const harness = await setUp();
    const { node, send, call } = harness;
    const connection = await openKnown(harness);
    resultOf(await send(connection, { from: COW, to: TO }));
    node.pending = 7n;
    const { response } = await call(connection, "eth_getTransactionCount", [COW, "pending"]);
    assert.equal(resultOf(response), "0x7");
  });

  for (const [what, params] of [
    ["another block tag", [COW, "latest"]],
    ["another address", [OTHER, "pending"]],
    ["a malformed address", ["0x1234", "pending"]],
  ] as const) {
    it(`passes on a read for ${what} unchanged`, async () => {
      const harness = await setUp();
      const { send, call } = harness;
      const connection = await openKnown(harness);
      resultOf(await send(connection, { from: COW, to: TO }));
      const { response } = await call(connection, "eth_getTransactionCount", [...params]);
      assert.equal(resultOf(response), "0x0");
    });
  }

  it("passes on eth_fillTransaction's answer unchanged after waiting for the send", async () => {
    const harness = await setUp();
    const { node, send, call } = harness;
    const connection = await openKnown(harness);
    const held = gate();
    node.onRaw = async (raw) => {
      await held.promise;
      return { jsonrpc: "2.0", id: 1, result: hashOf(raw) };
    };
    const sending = send(connection, { from: COW, to: TO });
    await settle();
    let answered = false;
    const filling = call(connection, "eth_fillTransaction", [{ from: COW, to: TO }]).then(
      (read) => {
        answered = true;
        return read;
      },
    );
    await settle();
    assert.equal(answered, false, "the fill waits for the send");
    held.open();
    resultOf(await sending);
    assert.deepEqual(resultOf((await filling).response), { raw: "0x", tx: { nonce: "0x0" } });
    const other = await call(connection, "eth_fillTransaction", ["not a transaction"]);
    assert.deepEqual(resultOf(other.response), { raw: "0x", tx: { nonce: "0x0" } });
  });
});

/** A connection on which `getAccount` gave out cow's library account. */
async function openLibrary(harness: SendHarness): Promise<NetworkConnection<string>> {
  const connection = await openKnown(harness);
  await connection.kms.getAccount(COW);
  return connection;
}

/** Tells, after a few turns of the event loop, whether a promise has settled. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise
    .catch(() => undefined)
    .finally(() => {
      done = true;
    });
  await settle();
  return done;
}

describe("a nonce read for a library account", () => {
  it("holds back the plugin's next send until the raw transaction with that nonce is sent", async () => {
    const harness = await setUp();
    const { node, send, call } = harness;
    const connection = await openLibrary(harness);
    const read = await call(connection, "eth_getTransactionCount", [COW, "pending"]);
    assert.equal(resultOf(read.response), "0x0");
    const sending = send(connection, { from: COW, to: TO });
    assert.equal(await settled(sending), false, "the send waits for the library's raw transaction");
    assert.deepEqual(node.raw, []);
    resultOf((await sendRaw(harness, connection, cowRaw(0n))).response);
    resultOf(await sending);
    assert.deepEqual(node.raw.map(nonceOf), [0n, 1n]);
  });

  it("ends the lease even when the node refuses the raw transaction", async () => {
    const harness = await setUp();
    const { node, send, call } = harness;
    const connection = await openLibrary(harness);
    await call(connection, "eth_getTransactionCount", [COW, "pending"]);
    const sending = send(connection, { from: COW, to: TO });
    assert.equal(await settled(sending), false);
    refuse(node, "insufficient funds");
    errorOf((await sendRaw(harness, connection, cowRaw(0n))).response);
    node.onRaw = undefined;
    resultOf(await sending);
    assert.deepEqual(node.raw.map(nonceOf), [0n, 0n], "the refused nonce is free again");
  });

  it(`lets the send go after ${NONCE_LEASE_MS / 1000} s when no raw transaction comes`, async () => {
    const harness = await setUp();
    const { node, timers, send, call } = harness;
    const connection = await openLibrary(harness);
    await call(connection, "eth_getTransactionCount", [COW, "pending"]);
    const sending = send(connection, { from: COW, to: TO });
    assert.equal(await settled(sending), false);
    timers.fire();
    resultOf(await sending);
    assert.deepEqual(node.raw.map(nonceOf), [0n]);
  });

  it("does not hold back a send with the caller's nonce, or another account's send", async () => {
    const harness = await setUp();
    const { node, send, call } = harness;
    const connection = await openLibrary(harness);
    await call(connection, "eth_getTransactionCount", [COW, "pending"]);
    resultOf(await send(connection, { from: COW, to: TO, nonce: "0x0" }));
    resultOf(await send(connection, { from: ZERO, to: TO }));
    assert.equal(node.raw.length, 2);
  });

  it("leases eth_fillTransaction's nonce too", async () => {
    const harness = await setUp();
    const { node, send, call } = harness;
    const connection = await openLibrary(harness);
    await call(connection, "eth_fillTransaction", [{ from: COW, to: TO }]);
    const sending = send(connection, { from: COW, to: TO });
    assert.equal(await settled(sending), false);
    resultOf((await sendRaw(harness, connection, cowRaw(0n))).response);
    resultOf(await sending);
    assert.deepEqual(node.raw.map(nonceOf), [0n, 1n]);
  });

  it("leases nothing for an account without a library account", async () => {
    const harness = await setUp();
    const { node, send, call } = harness;
    const connection = await openLibrary(harness);
    await call(connection, "eth_getTransactionCount", [ZERO, "pending"]);
    resultOf(await send(connection, { from: ZERO, to: TO }));
    assert.equal(node.raw.length, 1);
  });

  it("makes a send that got the lock after a new lease wait again", async () => {
    const harness = await setUp();
    const { node, send, call } = harness;
    const connection = await openLibrary(harness);
    const held = gate();
    node.onRaw = async (raw) => {
      await held.promise;
      return { jsonrpc: "2.0", id: 1, result: hashOf(raw) };
    };
    // A holds the lock; then a library read waits for it; then B waits behind the read.
    const first = send(connection, { from: COW, to: TO });
    await settle();
    const reading = call(connection, "eth_getTransactionCount", [COW, "pending"]);
    await settle();
    const second = send(connection, { from: COW, to: TO });
    await settle();
    node.onRaw = undefined;
    held.open();
    resultOf(await first);
    assert.equal(resultOf((await reading).response), "0x1", "the read waited for A");
    assert.equal(await settled(second), false, "B got the lock after the lease, and waits");
    resultOf((await sendRaw(harness, connection, cowRaw(1n))).response);
    resultOf(await second);
    assert.deepEqual(node.raw.map(nonceOf), [0n, 1n, 2n]);
    assert.equal(sendLocksInUse(), 0);
  });
});
