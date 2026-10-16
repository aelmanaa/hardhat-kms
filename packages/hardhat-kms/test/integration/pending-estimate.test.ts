// #492 on real EDR: a self-sponsored EIP-7702 delegate-and-call sent while the account's previous
// transaction is still pending. Its authorization nonce counts that transaction, so an estimate
// at `latest` skips the authorization and signs too little gas; at `pending` it covers it.
//
// EDR answers an `eth_estimateGas` without a block tag at `pending`, but geth, reth, Erigon and
// Nethermind answer it at `latest`. The tests give EDR geth's default: a network hook adds
// `latest` to an estimate that has no block tag. Without the fix the plugin sent no tag.
import assert from "node:assert/strict";
import { it } from "node:test";

import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { JsonRpcResponse } from "hardhat/types/providers";

import hardhatKms from "../../src/index.ts";
import { fakeAdapter } from "../helpers/fake-adapter.ts";
import { vaultKey } from "../helpers/vault-key.ts";
import { COW_ACCOUNT } from "../helpers/vectors.ts";

const COW = COW_ACCOUNT.address;
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DELEGATE = "0x00000000000000000000000000000000000c0de1";
// Adds 1 to storage slot 0 on any call: PUSH1 1, PUSH1 0, SLOAD, ADD, PUSH1 0, SSTORE, STOP.
const COUNTER = "0x60016000540160005500";
// add(1), as the live suite's LiveCheck takes it; the counter ignores the calldata.
const ADD_ONE = `0x1003e2d2${"0".repeat(63)}1`;

/**
 * A funded KMS account on a node that mines only when asked, and that answers an estimate without
 * a block tag at `latest`, as geth does.
 *
 * @param refusePending - Also refuse an estimate at `pending` with -32602, as some nodes do.
 * @param tags - Receives the block tag of each estimate the plugin sends, `none` for no tag.
 */
async function connect(refusePending = false, tags: unknown[] = []) {
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKms],
    kms: { keys: { cow: vaultKey("cow") }, simulatedBalance: 10n ** 18n },
    networks: { local: { type: "edr-simulated", kmsAccounts: ["cow"], mining: { auto: false } } },
  });
  hre.hooks.registerHandlers("network", {
    onRequest: async (context, connection, request, next): Promise<JsonRpcResponse> => {
      const params = request.params;
      if (request.method !== "eth_estimateGas" || !Array.isArray(params)) {
        return await next(context, connection, request);
      }
      tags.push(params[1] ?? "none");
      if (refusePending && params[1] === "pending") {
        const error = { code: -32602, message: "invalid argument 1: pending is not supported" };
        return { jsonrpc: "2.0", id: request.id, error };
      }
      const tagged = params.length === 1 ? [...params, "latest"] : params;
      return await next(context, connection, { ...request, params: tagged });
    },
  });
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async () =>
      fakeAdapter({ secretKey: new Uint8Array(Buffer.from(COW_ACCOUNT.secretKey, "hex")) }),
  });
  return await hre.network.create({ network: "local" });
}

/** A JSON-RPC answer's field. */
function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

/** The connection's requests, as plain JSON-RPC calls. */
type Request = (method: string, params?: unknown[]) => Promise<unknown>;

/** Sends plain JSON-RPC calls on a connection. */
function requestOn(connection: Awaited<ReturnType<typeof connect>>): Request {
  return async (method, params = []) => {
    const result: unknown = await connection.provider.request({ method, params });
    return result;
  };
}

/**
 * Queues an ordinary transaction from the account, then a self-sponsored delegate-and-call whose
 * authorization takes the nonce after both, and mines one block.
 *
 * @returns The two receipts.
 */
async function sendBehindPending(
  connection: Awaited<ReturnType<typeof connect>>,
  request: Request,
): Promise<unknown[]> {
  await request("evm_setAutomine", [false]);
  await request("hardhat_setCode", [DELEGATE, COUNTER]);
  // An ordinary transaction from the account, still pending: nonce 0.
  const first = await request("eth_sendTransaction", [{ from: COW, to: TO, value: "0x1" }]);
  assert.equal(await request("eth_getTransactionCount", [COW, "latest"]), "0x0");
  assert.equal(await request("eth_getTransactionCount", [COW, "pending"]), "0x1");
  // The delegate-and-call takes nonce 1, so its own authorization takes nonce 2.
  const account = await connection.kms.getAccount(COW);
  const signed = await account.signAuthorization({
    contractAddress: DELEGATE,
    chainId: 31337,
    nonce: 2,
  });
  const second = await request("eth_sendTransaction", [
    {
      from: COW,
      to: COW,
      value: "0x1",
      data: ADD_ONE,
      authorizationList: [
        {
          chainId: "0x7a69",
          address: DELEGATE,
          nonce: "0x2",
          yParity: `0x${(signed.yParity ?? 0).toString(16)}`,
          r: signed.r,
          s: signed.s,
        },
      ],
    },
  ]);
  await request("evm_mine");
  const receipts = await Promise.all(
    [first, second].map(async (hash) => await request("eth_getTransactionReceipt", [hash])),
  );
  return receipts;
}

it("covers a self-sponsored EIP-7702 authorization sent behind a pending transaction (#492)", async () => {
  const connection = await connect();
  const request = requestOn(connection);
  try {
    const receipts = await sendBehindPending(connection, request);
    assert.deepEqual(
      receipts.map((receipt) => field(receipt, "blockNumber")),
      ["0x1", "0x1"],
      "both transactions are in the block just mined",
    );
    const [, delegated] = receipts;
    assert.equal(field(delegated, "type"), "0x4");
    assert.equal(
      field(delegated, "status"),
      "0x1",
      `the delegate-and-call failed with ${String(field(delegated, "gasUsed"))} gas used`,
    );
    assert.equal(await request("eth_getCode", [COW, "latest"]), `0xef0100${DELEGATE.slice(2)}`);
    // The delegated code ran in the account: its slot 0 counted the call.
    assert.equal(BigInt(String(await request("eth_getStorageAt", [COW, "0x0", "latest"]))), 1n);
    assert.equal(await request("eth_getTransactionCount", [COW, "latest"]), "0x3");
  } finally {
    await connection.close();
  }
});

it("estimates again without a block tag on a node that refuses pending, as before the fix", async () => {
  const tags: unknown[] = [];
  const connection = await connect(true, tags);
  const request = requestOn(connection);
  try {
    const [ordinary, delegated] = await sendBehindPending(connection, request);
    assert.deepEqual(tags, ["pending", "none", "pending", "none"]);
    assert.equal(field(ordinary, "status"), "0x1");
    // The fallback is the estimate Hardhat sends: at latest this node skips the authorization, so
    // the delegate-and-call runs out of gas. Its authorization still applies, as EIP-7702 says.
    assert.equal(field(delegated, "status"), "0x0");
    assert.equal(await request("eth_getCode", [COW, "latest"]), `0xef0100${DELEGATE.slice(2)}`);
  } finally {
    await connection.close();
  }
});

it("estimates a replacement of a pending self-sponsored EIP-7702 transaction without a block tag", async () => {
  const tags: unknown[] = [];
  const connection = await connect(false, tags);
  const request = requestOn(connection);
  try {
    await request("evm_setAutomine", [false]);
    await request("hardhat_setCode", [DELEGATE, COUNTER]);
    const account = await connection.kms.getAccount(COW);
    // The transaction takes nonce 0, so its own authorization takes nonce 1.
    const signed = await account.signAuthorization({
      contractAddress: DELEGATE,
      chainId: 31337,
      nonce: 1,
    });
    const delegateAndCall = (maxFeePerGas: bigint) => ({
      from: COW,
      to: COW,
      value: "0x1",
      data: ADD_ONE,
      maxFeePerGas: `0x${maxFeePerGas.toString(16)}`,
      maxPriorityFeePerGas: `0x${(maxFeePerGas / 2n).toString(16)}`,
      authorizationList: [
        {
          chainId: "0x7a69",
          address: DELEGATE,
          nonce: "0x1",
          yParity: `0x${(signed.yParity ?? 0).toString(16)}`,
          r: signed.r,
          s: signed.s,
        },
      ],
    });
    const original = await request("eth_sendTransaction", [delegateAndCall(4_000_000_000n)]);
    // A fee bump with the same nonce: the pending state already holds the original, so its
    // authorization would be skipped there.
    const replacement = await request("eth_sendTransaction", [
      { ...delegateAndCall(8_000_000_000n), nonce: "0x0" },
    ]);
    await request("evm_mine");
    assert.equal(await request("eth_getTransactionReceipt", [original]), null);
    const receipt = await request("eth_getTransactionReceipt", [replacement]);
    assert.equal(
      field(receipt, "status"),
      "0x1",
      `the replacement failed with ${String(field(receipt, "gasUsed"))} gas used`,
    );
    // The original is estimated at pending, the replacement as Hardhat estimates it.
    assert.deepEqual(tags, ["pending", "none"]);
    assert.equal(await request("eth_getCode", [COW, "latest"]), `0xef0100${DELEGATE.slice(2)}`);
    assert.equal(BigInt(String(await request("eth_getStorageAt", [COW, "0x0", "latest"]))), 1n);
  } finally {
    await connection.close();
  }
});
