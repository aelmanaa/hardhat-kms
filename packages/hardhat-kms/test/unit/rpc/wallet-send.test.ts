// wallet_sendTransaction through the network hook's handlers with a fake node: refused for a KMS
// sender, so the wallet_sendTransaction viem sends after a failed send never moves a client's
// sends away from the plugin.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { NetworkConnection } from "hardhat/types/network";
import { BaseError, createWalletClient, custom, getAddress } from "viem";

import { SendOutcomeUnknownError, sendLocksInUse } from "../../../src/internal/rpc/send-guard.ts";
import {
  COW,
  errorOf,
  failOnce,
  hashOf,
  refuse,
  resultOf,
  type SendHarness,
  setUp,
  TO,
  WALLET_SEND_HASH,
} from "../../helpers/send-harness.ts";

/** Hardhat's third default account, which is not a KMS account here. */
const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

const METHOD_NOT_FOUND = -32601;

/** Sends wallet_sendTransaction through the hook, and returns what reached the node. */
async function walletSend(harness: SendHarness, params: unknown[]) {
  const connection = await harness.open();
  return await harness.call(connection, "wallet_sendTransaction", params);
}

/**
 * An EIP-1193 provider over the hook, as `connection.provider` is: an error answer is thrown with
 * its code, which viem maps to its RPC error classes.
 */
function providerOf(
  harness: SendHarness,
  connection: NetworkConnection<string>,
): { request: (args: { method: string; params?: unknown }) => Promise<unknown> } {
  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    const { response } = await harness.call(
      connection,
      method,
      Array.isArray(params) ? params : [],
    );
    if ("error" in response) {
      throw Object.assign(new Error(response.error.message), { code: response.error.code });
    }
    return response.result;
  };
  return { request };
}

// The send locks are process-global: a lock that one test leaves held or waited for would hold up
// the sends of the tests after it.
let locksBefore = 0;
beforeEach(() => {
  locksBefore = sendLocksInUse();
});
afterEach(() => {
  assert.ok(sendLocksInUse() <= locksBefore, "the test left a send lock held or waited for");
});

describe("wallet_sendTransaction", () => {
  for (const [label, from] of [
    ["checksummed", COW],
    ["lowercase", COW.toLowerCase()],
    ["uppercase hex", `0x${COW.slice(2).toUpperCase()}`],
  ] as const) {
    it(`is refused with -32601 for a KMS sender (${label}), and nothing reaches the node`, async () => {
      const harness = await setUp();
      const { response, forwarded } = await walletSend(harness, [{ from, to: TO, value: "0x1" }]);
      const error = errorOf(response);
      assert.equal(error.code, METHOD_NOT_FOUND);
      assert.equal(response.id, 1, "the answer carries the request's id");
      assert.equal(
        error.message,
        `wallet_sendTransaction is not available for the KMS account ${COW}. Send with eth_sendTransaction, which the plugin signs.`,
      );
      assert.equal(forwarded.length, 0);
      assert.equal(harness.state.signatures, 0);
      assert.ok(!harness.node.methods.includes("wallet_sendTransaction"));
    });
  }

  it("passes a sender that is not a KMS account to the node unchanged", async () => {
    const harness = await setUp();
    const params = [{ from: OTHER, to: TO, value: "0x1" }];
    const { response, forwarded } = await walletSend(harness, params);
    assert.equal(resultOf(response), WALLET_SEND_HASH);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0]?.method, "wallet_sendTransaction");
    assert.equal(forwarded[0]?.params, params, "the params go on as they came");
    assert.equal(harness.state.signatures, 0);
  });

  for (const [label, params] of [
    ["no params", []],
    ["a first param that is not an object", ["0x1"]],
    ["a transaction without from", [{ to: TO, value: "0x1" }]],
    ["a from that is not an address", [{ from: "cow", to: TO }]],
  ] as const) {
    it(`passes ${label} to the node unchanged`, async () => {
      const harness = await setUp();
      const { response, forwarded } = await walletSend(harness, [...params]);
      assert.equal(resultOf(response), WALLET_SEND_HASH);
      assert.equal(forwarded.length, 1);
      assert.deepEqual(forwarded[0]?.params, params);
    });
  }

  it("keeps a viem client sending through the plugin after a -32000 answer", async () => {
    const harness = await setUp();
    const { node, state } = harness;
    const connection = await harness.open();
    const client = createWalletClient({
      account: getAddress(COW),
      transport: custom(providerOf(harness, connection)),
    });

    // The node rejects the first broadcast with -32000, as Geth does for "nonce too low". viem then
    // sends wallet_sendTransaction once, which the fake node would answer with a hash.
    refuse(node, "nonce too low");
    await assert.rejects(client.sendTransaction({ to: TO, value: 1n, chain: null }), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /nonce too low/);
      return true;
    });
    assert.equal(state.signatures, 1);
    assert.equal(node.raw.length, 1);

    node.onRaw = undefined;
    for (let send = 2; send <= 3; send++) {
      const hash = await client.sendTransaction({ to: TO, value: 1n, chain: null });
      assert.notEqual(hash, WALLET_SEND_HASH);
      assert.equal(state.signatures, send, "one KMS signature per send");
      assert.equal(node.raw.length, send, "each send reaches the node as a raw transaction");
    }
    assert.ok(!node.methods.includes("wallet_sendTransaction"));
  });

  it("keeps sendTransactionSync on the plugin after a -32000 answer", async () => {
    const harness = await setUp();
    const { node, state } = harness;
    const connection = await harness.open();
    const client = createWalletClient({
      account: getAddress(COW),
      transport: custom(providerOf(harness, connection)),
    });

    // viem's sendTransactionSync keeps its own record of whether the client has a wallet
    // namespace, and sends wallet_sendTransaction after a failed send just as sendTransaction does.
    refuse(node, "nonce too low");
    await assert.rejects(
      client.sendTransactionSync({ to: TO, value: 1n, chain: null }),
      /nonce too low/,
    );
    assert.equal(state.signatures, 1);

    node.onRaw = undefined;
    for (let send = 2; send <= 3; send++) {
      const receipt = await client.sendTransactionSync({ to: TO, value: 1n, chain: null });
      assert.equal(receipt.status, "success");
      assert.equal(receipt.transactionHash, hashOf(node.raw[send - 1] ?? ""));
      assert.equal(state.signatures, send, "one KMS signature per send");
      assert.equal(node.raw.length, send, "each send reaches the node as a raw transaction");
    }
    assert.ok(!node.methods.includes("wallet_sendTransaction"));
  });

  it("leaves the hash of a send without an answer in viem's error", async () => {
    const harness = await setUp();
    const { node, state } = harness;
    const connection = await harness.open();
    const client = createWalletClient({
      account: getAddress(COW),
      transport: custom(providerOf(harness, connection)),
    });

    failOnce(node);
    const outcome = await client.sendTransaction({ to: TO, value: 1n, chain: null }).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(outcome instanceof BaseError, String(outcome));
    const unknown = outcome.walk((cause) => cause instanceof SendOutcomeUnknownError);
    assert.ok(unknown instanceof SendOutcomeUnknownError, "the plugin's error is in the chain");
    const [raw] = node.raw;
    assert.ok(raw !== undefined);
    assert.equal(unknown.transactionHash, hashOf(raw));
    assert.equal(state.signatures, 1);

    const hash = await client.sendTransaction({ to: TO, value: 2n, chain: null });
    assert.equal(state.signatures, 2);
    assert.equal(node.raw.length, 2);
    assert.equal(hash, hashOf(node.raw[1] ?? ""));
    assert.ok(!node.methods.includes("wallet_sendTransaction"));
  });
});
