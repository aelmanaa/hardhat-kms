// Raw transactions and nonce reads of KMS accounts, through the network hook's handlers with a
// fake node: the send lock, the high-water mark and the pass-through of everything else.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardhatError } from "@nomicfoundation/hardhat-errors";
import type { NetworkConnection } from "hardhat/types/network";
import type { JsonRpcResponse } from "hardhat/types/providers";
import { Transaction } from "micro-eth-signer";
import { serializeTransaction, toHex } from "viem";

import { MAX_SEND_LOCK_WAITERS, sendLocksInUse } from "../../../src/internal/rpc/send-guard.ts";
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
    const waiting = Array.from(
      { length: MAX_SEND_LOCK_WAITERS },
      async (_, i) => await call(connection, "eth_sendRawTransaction", [cowRaw(BigInt(i + 2))]),
    );
    await settle();
    assert.equal(node.raw.length, 1, "the raw transactions wait for the lock");
    node.onRaw = undefined;
    // The queue is full: the raw transaction goes on at once, without the lock.
    resultOf((await sendRaw(harness, connection, cowRaw(1n))).response);
    assert.equal(node.raw.length, 2);
    held.open();
    resultOf(await sending);
    await Promise.all(waiting);
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
    assert.equal(sendLocksInUse(), 0);
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
    assert.equal(sendLocksInUse(), 0);
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
    assert.equal(sendLocksInUse(), 0);
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
    assert.equal(sendLocksInUse(), 0);
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
    assert.equal(sendLocksInUse(), 0);
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
