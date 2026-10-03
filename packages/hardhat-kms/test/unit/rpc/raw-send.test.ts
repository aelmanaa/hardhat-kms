// Raw transactions and nonce reads of KMS accounts, through the network hook's handlers with a
// fake node: the send lock, the high-water mark and the pass-through of everything else.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { HardhatError } from "@nomicfoundation/hardhat-errors";
import type { NetworkConnection } from "hardhat/types/network";
import type { JsonRpcResponse } from "hardhat/types/providers";
import { Transaction } from "micro-eth-signer";
import { serializeTransaction, toHex } from "viem";

import {
  MAX_SEND_LOCK_WAITERS,
  SEND_LOCK_STALL_MS,
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
  method = "eth_sendRawTransaction",
): Promise<{ response: JsonRpcResponse; params: unknown[]; forwardedParams: unknown[] }> {
  const params = [raw];
  const { response, forwarded } = await harness.call(connection, method, params);
  assert.equal(forwarded.length, 1, "exactly one request reached the node");
  const [request] = forwarded;
  assert.ok(request !== undefined);
  assert.equal(request.method, method);
  assert.ok(Array.isArray(request.params));
  return { response, params, forwardedParams: request.params };
}

// The send locks are process-global: a lock that one test leaves held or waited for would hold up
// the sends of the tests after it. The check fails the test that leaves one, and only that test.
let locksBefore = 0;
beforeEach(() => {
  locksBefore = sendLocksInUse();
});
afterEach(() => {
  assert.ok(sendLocksInUse() <= locksBefore, "the test left a send lock held or waited for");
});

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
  });

  it(`passes on unchanged when ${MAX_SEND_LOCK_WAITERS} requests already wait for the lock`, async (t) => {
    // The send lock's no-progress limit runs on the global setTimeout, which this mock drives.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    // A chain id of its own: if this test fails or times out, the sends it queued cannot fill the
    // queue of a later test.
    const harness = await setUp("http", 31338);
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const held = gate();
    /** Lets the holder end, and fails every waiter at once, unsigned, at the no-progress limit. */
    const drain = (): void => {
      held.open();
      t.mock.timers.tick(SEND_LOCK_STALL_MS);
    };
    // Runs even when the test fails or times out, so no waiter outlives it.
    t.after(drain);
    node.onRaw = async (raw) => {
      await held.promise;
      return { jsonrpc: "2.0", id: 1, result: hashOf(raw) };
    };
    const sending = send(connection, { from: COW, to: TO });
    await settle();
    // Sends fill the queue: a send waits before it fills or signs. A raw transaction is signed by
    // the test and decoded by the plugin before it waits, about 5 ms of CPU each when idle, so 1024
    // of them ran past the test timeout on a loaded machine.
    const waiting = Array.from(
      { length: MAX_SEND_LOCK_WAITERS },
      async () => await send(connection, { from: COW, to: TO }),
    );
    await settle();
    assert.equal(node.raw.length, 1, "the sends wait for the lock");
    node.onRaw = undefined;
    // The queue is full: the raw transaction goes on at once, without the lock.
    resultOf((await sendRaw(harness, connection, cowRaw(1n))).response);
    assert.equal(node.raw.length, 2);
    drain();
    const waited = await Promise.allSettled(waiting);
    assert.ok(
      waited.every(
        (outcome) => outcome.status === "rejected" && /none finished/.test(String(outcome.reason)),
      ),
      "every waiter reached the no-progress limit",
    );
    resultOf(await sending);
    assert.equal(node.raw.length, 2, "no waiter was sent");
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

  it("passes on a blob transaction in its network form, which the plugin does not decode", async () => {
    const harness = await setUp();
    const connection = await openKnown(harness);
    // Type 3 with its blobs, commitments and proofs, as viem sends one: micro-eth-signer decodes
    // only the bare transaction, so the sender is unknown and the request goes on untouched.
    const raw = serializeTransaction(
      {
        type: "eip4844",
        chainId: 31337,
        nonce: 0,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
        maxFeePerBlobGas: 1n,
        gas: 21_000n,
        to: TO,
        blobVersionedHashes: [`0x01${"00".repeat(31)}`],
        sidecars: [
          {
            blob: toHex(new Uint8Array(131_072)),
            commitment: `0x${"00".repeat(48)}`,
            proof: `0x${"00".repeat(48)}`,
          },
        ],
      },
      { r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, yParity: 0 },
    );
    assert.throws(() => Transaction.fromHex(raw, false));
    const { response, params, forwardedParams } = await sendRaw(harness, connection, raw);
    assert.equal(resultOf(response), hashOf(raw));
    assert.equal(forwardedParams, params);
    assert.deepEqual(harness.node.methods, ["eth_sendRawTransaction"]);
  });

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

/** A viem client whose transport does not go through Hardhat. */
const HTTP_CLIENT = { transport: { type: "http" } };

/** A library account of cow on a connection, and its nonce manager's calls. */
async function library(connection: NetworkConnection<string>, client: unknown = {}) {
  const account = await connection.kms.getAccount(COW);
  const parameters = { address: account.address, chainId: 31337, client };
  return {
    consume: async (): Promise<number> => await account.nonceManager.consume(parameters),
    get: async (): Promise<number> => await account.nonceManager.get(parameters),
    reset: async (): Promise<void> => {
      account.nonceManager.reset(parameters);
      await settle();
    },
    account,
    parameters,
  };
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

describe("a library account's send through the connection", () => {
  it("holds the account's lock from its nonce to its raw transaction", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const manager = await library(connection);
    assert.equal(await manager.consume(), 0);
    const sending = send(connection, { from: COW, to: TO });
    assert.equal(await settled(sending), false, "the plugin's send waits, as for any send");
    resultOf((await sendRaw(harness, connection, cowRaw(0n))).response);
    resultOf(await sending);
    assert.deepEqual(node.raw.map(nonceOf), [0n, 1n]);
  });

  it("makes a second library send wait for the first one's broadcast", async () => {
    const harness = await setUp();
    const connection = await openKnown(harness);
    const manager = await library(connection);
    assert.equal(await manager.consume(), 0);
    const second = manager.consume();
    assert.equal(await settled(second), false);
    resultOf((await sendRaw(harness, connection, cowRaw(0n))).response);
    assert.equal(await second, 1);
    resultOf((await sendRaw(harness, connection, cowRaw(1n))).response);
  });

  it("ends the hold at viem's reset, and frees the nonce", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const manager = await library(connection);
    assert.equal(await manager.consume(), 0);
    const sending = send(connection, { from: COW, to: TO });
    assert.equal(await settled(sending), false);
    await manager.reset();
    resultOf(await sending);
    assert.deepEqual(node.raw.map(nonceOf), [0n]);
  });

  it("ends the hold when its raw transaction fails, and its reset then ends no other hold", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const first = await library(connection);
    const second = await library(connection);
    assert.equal(await first.consume(), 0);
    const secondNonce = second.consume();
    refuse(node, "insufficient funds");
    errorOf((await sendRaw(harness, connection, cowRaw(0n))).response);
    node.onRaw = undefined;
    assert.equal(await secondNonce, 0, "the refused nonce is free again");
    await first.reset();
    const sending = send(connection, { from: COW, to: TO });
    assert.equal(await settled(sending), false, "the second library send still holds the lock");
    resultOf((await sendRaw(harness, connection, cowRaw(0n))).response);
    resultOf(await sending);
    assert.deepEqual(node.raw.map(nonceOf), [0n, 0n, 1n]);
  });

  it("lets a raw transaction with another nonce wait behind the hold", async () => {
    const harness = await setUp();
    const { node } = harness;
    const connection = await openKnown(harness);
    const manager = await library(connection);
    assert.equal(await manager.consume(), 0);
    const other = sendRaw(harness, connection, cowRaw(5n));
    assert.equal(await settled(other), false);
    resultOf((await sendRaw(harness, connection, cowRaw(0n))).response);
    resultOf((await other).response);
    assert.deepEqual(node.raw.map(nonceOf), [0n, 5n]);
  });

  it("ends the hold when its connection closes", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const other = await openKnown(harness);
    const manager = await library(connection);
    assert.equal(await manager.consume(), 0);
    const sending = send(other, { from: COW, to: TO });
    assert.equal(await settled(sending), false, "the lock is per chain and address");
    await harness.close(connection);
    resultOf(await sending);
    assert.deepEqual(node.raw.map(nonceOf), [0n]);
  });

  it("waits for a send through the plugin in progress, then gives the next nonce", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const manager = await library(connection);
    const held = gate();
    node.onRaw = async (raw) => {
      await held.promise;
      return { jsonrpc: "2.0", id: 1, result: hashOf(raw) };
    };
    const sending = send(connection, { from: COW, to: TO });
    await settle();
    const consuming = manager.consume();
    assert.equal(await settled(consuming), false, "consume waits for the broadcast");
    held.open();
    resultOf(await sending);
    assert.equal(await consuming, 1);
    await manager.reset();
  });

  it("fails at once when called from inside a send from the same account, and its reset ends no hold", async () => {
    const harness = await setUp();
    const { node, state, send } = harness;
    const connection = await openKnown(harness);
    const manager = await library(connection);
    let inner: unknown;
    state.beforeSign = async (name) => {
      if (name === "cow" && inner === undefined) {
        inner = await manager.consume().catch((error: unknown) => error);
      }
    };
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.ok(inner instanceof Error);
    assert.match(
      inner.message,
      new RegExp(`library account ${COW.toLowerCase()} on chain 31337 was started from inside`),
    );
    state.beforeSign = undefined;
    const holder = await library(connection);
    assert.equal(await holder.consume(), 1);
    // The failed consume's reset comes late; the holder keeps the lock.
    await manager.reset();
    const sending = send(connection, { from: COW, to: TO });
    assert.equal(await settled(sending), false);
    resultOf((await sendRaw(harness, connection, cowRaw(1n))).response);
    resultOf(await sending);
    assert.deepEqual(node.raw.map(nonceOf), [0n, 1n, 2n]);
  });

  it("gives get's nonce without holding anything", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const manager = await library(connection);
    assert.equal(await manager.get(), 0);
    manager.account.nonceManager.increment(manager.parameters);
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.equal(await manager.get(), 1, "past the mark");
    assert.deepEqual(node.raw.map(nonceOf), [0n]);
  });

  it("holds nothing for another chain, gives the node's pending count, and ignores its reset", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const manager = await library(connection);
    resultOf(await send(connection, { from: COW, to: TO }));
    const holder = await library(connection);
    assert.equal(await holder.consume(), 1);
    const foreign = { ...manager.parameters, chainId: 1 };
    assert.equal(await manager.account.nonceManager.consume(foreign), 0, "the node's count");
    manager.account.nonceManager.reset(foreign);
    await settle();
    const sending = send(connection, { from: COW, to: TO });
    assert.equal(await settled(sending), false, "the holder still holds the lock");
    resultOf((await sendRaw(harness, connection, cowRaw(1n))).response);
    resultOf(await sending);
    assert.deepEqual(node.raw.map(nonceOf), [0n, 1n, 2n]);
  });

  it("refuses once the connection is closed", async () => {
    const harness = await setUp();
    const connection = await openKnown(harness);
    const manager = await library(connection);
    await harness.close(connection);
    await assert.rejects(manager.consume(), /nonceManager\.consume: the connection to network/);
    await assert.rejects(manager.get(), /nonceManager\.get: the connection to network/);
  });
});

describe("a library account's send with its own transport", () => {
  it("reserves the nonce, which a send through the plugin then skips without waiting", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const manager = await library(connection, HTTP_CLIENT);
    assert.equal(await manager.consume(), 0);
    assert.equal(await manager.consume(), 1);
    const sending = send(connection, { from: COW, to: TO });
    assert.equal(await settled(sending), true, "no wait");
    resultOf(await sending);
    assert.deepEqual(node.raw.map(nonceOf), [2n]);
  });

  it("ends the reservation at reset", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const manager = await library(connection, HTTP_CLIENT);
    assert.equal(await manager.consume(), 0);
    await manager.reset();
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.deepEqual(node.raw.map(nonceOf), [0n]);
  });

  it("resets an unsigned reservation before a signed one", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const manager = await library(connection, HTTP_CLIENT);
    assert.equal(await manager.consume(), 0);
    await manager.account.signTransaction({
      type: "eip1559",
      chainId: 31337,
      nonce: 0,
      gas: 21_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      to: TO,
      value: 1n,
    });
    assert.equal(await manager.consume(), 1);
    await manager.reset();
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.deepEqual(node.raw.map(nonceOf), [1n], "0 is still reserved, 1 is free again");
  });

  it("is cleared by a send through the plugin with the caller's nonce at or above it", async () => {
    const harness = await setUp("edr-simulated");
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const manager = await library(connection, HTTP_CLIENT);
    assert.equal(await manager.consume(), 0);
    assert.equal(await manager.consume(), 1);
    resultOf(await send(connection, { from: COW, to: TO, nonce: "0x0" }));
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.deepEqual(node.raw.map(nonceOf), [0n, 2n], "1 still counts");
    resultOf(await send(connection, { from: COW, to: TO, nonce: "0x5" }));
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.deepEqual(node.raw.map(nonceOf), [0n, 2n, 5n, 0n], "both cleared; the node decides");
  });

  it("ends the reservation of a raw transaction that does reach the node through the connection", async () => {
    const harness = await setUp("edr-simulated");
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const manager = await library(connection, HTTP_CLIENT);
    assert.equal(await manager.consume(), 0);
    assert.equal(await manager.consume(), 1);
    refuse(node, "insufficient funds");
    errorOf((await sendRaw(harness, connection, cowRaw(0n))).response);
    node.onRaw = undefined;
    resultOf((await sendRaw(harness, connection, cowRaw(1n))).response);
    // 0 failed, so the reset that follows ends it; 1 reached the node.
    await manager.reset();
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.deepEqual(node.raw.map(nonceOf), [0n, 1n, 0n], "the mark is off; nothing is reserved");
  });
});

describe("a pending-count read for a KMS account", () => {
  it("passes on unchanged and does not wait, whatever the mark and the reservations", async () => {
    const harness = await setUp();
    const { node, send, call } = harness;
    const connection = await openKnown(harness);
    const manager = await library(connection, HTTP_CLIENT);
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.equal(await manager.consume(), 1);
    const held = gate();
    node.onRaw = async (raw) => {
      await held.promise;
      return { jsonrpc: "2.0", id: 1, result: hashOf(raw) };
    };
    const sending = send(connection, { from: COW, to: TO });
    await settle();
    for (const tag of ["pending", "latest"]) {
      const params = [COW, tag];
      const read = call(connection, "eth_getTransactionCount", params);
      assert.equal(await settled(read), true, `the ${tag} read does not wait for the send`);
      const { response, forwarded } = await read;
      assert.equal(resultOf(response), "0x0", "the node's count, as Ignition compares them");
      assert.equal(forwarded[0]?.params, params);
    }
    held.open();
    resultOf(await sending);
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.deepEqual(node.raw.map(nonceOf), [0n, 2n, 3n], "the reads changed nothing");
  });
});

describe("eth_sendRawTransactionSync (EIP-7966) from a KMS account", () => {
  const SYNC = "eth_sendRawTransactionSync";

  it("raises the mark when the receipt comes back, and passes the receipt on unchanged", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const raw = cowRaw(0n);
    const { response } = await sendRaw(harness, connection, raw, SYNC);
    assert.deepEqual(resultOf(response), { transactionHash: hashOf(raw), status: "0x1" });
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.deepEqual(node.raw.map(nonceOf), [0n, 1n]);
  });

  it("ends a library send's hold at its receipt", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const manager = await library(connection);
    assert.equal(await manager.consume(), 0);
    const sending = send(connection, { from: COW, to: TO });
    assert.equal(await settled(sending), false, "the plugin's send waits for the hold");
    resultOf((await sendRaw(harness, connection, cowRaw(0n), SYNC)).response);
    assert.equal(await settled(sending), true, "the hold ended at the receipt");
    resultOf(await sending);
    assert.deepEqual(node.raw.map(nonceOf), [0n, 1n]);
  });

  it("counts a timeout answer (code 4) as in the pool, ends the hold, and owes its reset", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const first = await library(connection);
    assert.equal(await first.consume(), 0);
    const raw = cowRaw(0n);
    node.onRaw = async () =>
      await Promise.resolve({
        jsonrpc: "2.0" as const,
        id: 1,
        error: { code: 4, message: "wasn't processed in time", data: hashOf(raw) },
      });
    const answer = await sendRaw(harness, connection, raw, SYNC);
    assert.equal(errorOf(answer.response).code, 4, "the answer comes back unchanged");
    node.onRaw = undefined;
    const second = await library(connection);
    assert.equal(await second.consume(), 1, "the mark rose");
    // viem resets after the timeout error; that reset is owed and leaves the second hold alone.
    await first.reset();
    const sending = send(connection, { from: COW, to: TO });
    assert.equal(await settled(sending), false, "the second library send still holds the lock");
    resultOf((await sendRaw(harness, connection, cowRaw(1n), SYNC)).response);
    resultOf(await sending);
    assert.deepEqual(node.raw.map(nonceOf), [0n, 1n, 2n]);
  });

  it("treats a refusal as the async method does: the nonce is free again", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const manager = await library(connection);
    assert.equal(await manager.consume(), 0);
    refuse(node, "nonce gap", 6);
    errorOf((await sendRaw(harness, connection, cowRaw(0n), SYNC)).response);
    node.onRaw = undefined;
    await manager.reset();
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.deepEqual(node.raw.map(nonceOf), [0n, 0n]);
  });

  it("passes another sender's transaction on unchanged", async () => {
    const harness = await setUp();
    const connection = await openKnown(harness);
    const raw = signedRaw(OTHER_SECRET, 0n);
    const { response, params, forwardedParams } = await sendRaw(harness, connection, raw, SYNC);
    resultOf(response);
    assert.equal(forwardedParams, params);
    assert.deepEqual(harness.node.methods, [SYNC]);
  });
});

describe("a reset when a held send and own-transport reservations are both open", () => {
  it("ends the reservation, not the hold of another consume", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const own = await library(connection, HTTP_CLIENT);
    const through = await library(connection);
    assert.equal(await own.consume(), 0, "X, reserved for an http client");
    assert.equal(await through.consume(), 1, "Y, held for a custom client");
    // X's send fails; viem resets with the address and chain only.
    await own.reset();
    const sending = send(connection, { from: COW, to: TO });
    assert.equal(await settled(sending), false, "the plugin's send still waits for Y");
    resultOf((await sendRaw(harness, connection, cowRaw(1n))).response);
    resultOf(await sending);
    const nonces = node.raw.map(nonceOf);
    assert.equal(new Set(nonces).size, nonces.length, "distinct nonces");
    assert.deepEqual(nonces, [1n, 2n], "the plugin's send goes after Y's");
  });

  it("first ends the reservations the node already has, then ends the hold", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const own = await library(connection, HTTP_CLIENT);
    const through = await library(connection);
    assert.equal(await own.consume(), 0);
    // The http client broadcast X; the node's pending count shows it.
    node.pending = 1n;
    assert.equal(await through.consume(), 1);
    await through.reset();
    const sending = send(connection, { from: COW, to: TO });
    assert.equal(await settled(sending), true, "Y's hold ended at its reset");
    resultOf(await sending);
    assert.deepEqual(node.raw.map(nonceOf), [1n]);
  });

  it("keeps the reservations when the pending count cannot be read", async () => {
    const harness = await setUp();
    const { node, send } = harness;
    const connection = await openKnown(harness);
    const own = await library(connection, HTTP_CLIENT);
    const through = await library(connection);
    assert.equal(await own.consume(), 0);
    assert.equal(await through.consume(), 1);
    let reads = 0;
    // The fake node fails the pending read of the reset.
    const original = Object.getOwnPropertyDescriptor(node, "pending");
    assert.ok(original !== undefined);
    Object.defineProperty(node, "pending", {
      configurable: true,
      get: () => {
        reads++;
        throw new Error("node down");
      },
    });
    await through.reset();
    Object.defineProperty(node, "pending", original);
    assert.equal(reads, 1);
    const sending = send(connection, { from: COW, to: TO });
    assert.equal(await settled(sending), false, "the reset took X's reservation; Y still holds");
    resultOf((await sendRaw(harness, connection, cowRaw(1n))).response);
    resultOf(await sending);
    assert.deepEqual(node.raw.map(nonceOf), [1n, 2n]);
  });
});

describe("a library account's consume after a broadcast with no answer", () => {
  it("looks the transaction up first, as a send through the plugin does", async () => {
    const harness = await setUp();
    const { node } = harness;
    const connection = await openKnown(harness);
    const raw = cowRaw(0n);
    node.onRaw = async () => {
      node.onRaw = undefined;
      await Promise.resolve();
      throw new Error("socket hang up");
    };
    await assert.rejects(sendRaw(harness, connection, raw), /socket hang up/);
    // The node has it, though its pending count lags at 0.
    node.lookUp = (hash) => (hash === hashOf(raw) ? { hash } : null);
    node.methods.length = 0;
    const manager = await library(connection);
    assert.equal(await manager.consume(), 1, "past the transaction the node has");
    assert.ok(node.methods.includes("eth_getTransactionByHash"));
    await manager.reset();
  });
});

describe("a library send's raw transaction on a connection that has not looked up its KMS addresses", () => {
  it("still ends the hold, with no KMS call", async () => {
    const harness = await setUp();
    const { node, state, send } = harness;
    const connection = await openKnown(harness);
    const other = await harness.open();
    const manager = await library(connection);
    assert.equal(await manager.consume(), 0);
    const signatures = state.signatures;
    const sending = send(connection, { from: COW, to: TO });
    assert.equal(await settled(sending), false);
    // The node counts it; the mark is per connection, and this one never saw it.
    node.onRaw = async (raw) => {
      node.onRaw = undefined;
      node.pending = 1n;
      return await Promise.resolve({ jsonrpc: "2.0" as const, id: 1, result: hashOf(raw) });
    };
    resultOf((await sendRaw(harness, other, cowRaw(0n))).response);
    assert.equal(await settled(sending), true, "the hold ended at the raw transaction");
    resultOf(await sending);
    assert.deepEqual(node.raw.map(nonceOf), [0n, 1n]);
    assert.equal(state.signatures, signatures + 1, "only the plugin's send signed");
  });

  it("passes on a transaction from an address that holds nothing", async () => {
    const harness = await setUp();
    const { node } = harness;
    const connection = await openKnown(harness);
    const other = await harness.open();
    const manager = await library(connection);
    assert.equal(await manager.consume(), 0);
    node.methods.length = 0;
    const raw = signedRaw(OTHER_SECRET, 0n);
    resultOf((await sendRaw(harness, other, raw)).response);
    assert.ok(!node.methods.includes("eth_getTransactionByHash"));
    await manager.reset();
  });
});
