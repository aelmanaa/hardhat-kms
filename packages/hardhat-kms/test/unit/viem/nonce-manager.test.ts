// A library account's viem nonce manager: what it asks of its connection, and how viem's own
// sendTransaction calls it. This file runs at the floor of viem's peer range too, which is the
// first viem release that calls `reset` only after `consume` and after any failed send.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardhatPluginError } from "hardhat/plugins";
import { createWalletClient, custom } from "viem";
import { hardhat } from "viem/chains";

import { createKmsNetworkConnection } from "../../../src/internal/viem/account.ts";
import { ADDRESS, CHAIN_ID, setup } from "../../helpers/library-account.ts";

const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const LOWER = ADDRESS.toLowerCase();
const TRANSACTION = {
  type: "eip1559",
  chainId: CHAIN_ID,
  nonce: 3,
  gas: 21_000n,
  maxFeePerGas: 2n,
  maxPriorityFeePerGas: 1n,
  to: TO,
  value: 1n,
} as const;

/** An EIP-1193 provider that answers what viem's send asks, and fails estimates on demand. */
function fakeNode(options: { failEstimate?: boolean } = {}) {
  const methods: string[] = [];
  const provider = {
    request: async ({ method }: { method: string; params?: unknown }): Promise<unknown> => {
      methods.push(method);
      await Promise.resolve();
      switch (method) {
        case "eth_chainId":
          return `0x${CHAIN_ID.toString(16)}`;
        case "eth_getBlockByNumber":
          return { baseFeePerGas: "0x1", number: "0x1", timestamp: "0x1", gasLimit: "0x1c9c380" };
        case "eth_maxPriorityFeePerGas":
          return "0x1";
        case "eth_estimateGas":
          if (options.failEstimate === true) {
            throw Object.assign(new Error("execution reverted"), { code: 3 });
          }
          return "0x5208";
        case "eth_sendRawTransaction":
          return `0x${"ab".repeat(32)}`;
        default:
          throw new Error(`the fake node does not answer ${method}`);
      }
    },
  };
  return { provider, methods };
}

describe("a library account's nonce manager", () => {
  it("asks the connection for a reserved nonce with consume, and an unreserved one with get", async () => {
    const { connection, nonceCalls } = setup();
    const account = await createKmsNetworkConnection(connection).getAccount(ADDRESS);
    const parameters = { address: ADDRESS, chainId: CHAIN_ID, client: {} };
    assert.equal(await account.nonceManager.consume(parameters), 7);
    assert.equal(await account.nonceManager.get(parameters), 7);
    account.nonceManager.increment(parameters);
    account.nonceManager.reset(parameters);
    assert.deepEqual(nonceCalls, [
      ["choose", { address: LOWER, chainId: BigInt(CHAIN_ID), reserve: true, ownTransport: false }],
      [
        "choose",
        { address: LOWER, chainId: BigInt(CHAIN_ID), reserve: false, ownTransport: false },
      ],
      ["reset", LOWER, BigInt(CHAIN_ID)],
    ]);
  });

  it("tells the connection when the client's transport does not go through Hardhat", async () => {
    const { connection, nonceCalls } = setup();
    const account = await createKmsNetworkConnection(connection).getAccount(ADDRESS);
    const ask = async (transport: unknown, run: "consume" | "get"): Promise<number> =>
      await account.nonceManager[run]({
        address: ADDRESS,
        chainId: CHAIN_ID,
        client: { transport },
      });
    await ask({ type: "http" }, "consume");
    await ask({ type: "custom" }, "consume");
    await ask({ type: "http" }, "get");
    assert.deepEqual(
      nonceCalls.map((call) => call[1]),
      [
        { address: LOWER, chainId: BigInt(CHAIN_ID), reserve: true, ownTransport: true },
        { address: LOWER, chainId: BigInt(CHAIN_ID), reserve: true, ownTransport: false },
        { address: LOWER, chainId: BigInt(CHAIN_ID), reserve: false, ownTransport: false },
      ],
    );
  });

  it("logs a reset that failed, and does not throw it to viem", async () => {
    const { connection } = setup();
    let resets = 0;
    connection.nonces.reset = async () => {
      resets++;
      throw await Promise.resolve(new Error("no chain"));
    };
    const account = await createKmsNetworkConnection(connection).getAccount(ADDRESS);
    account.nonceManager.reset({ address: ADDRESS, chainId: CHAIN_ID });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resets, 1);
  });

  it("notes the nonce of each transaction the KMS signed, and of no other", async () => {
    let refuse = false;
    const { connection, nonceCalls } = setup({
      adapter: {
        beforeSign: async () => {
          if (refuse) {
            throw await Promise.resolve(new Error("the KMS refused"));
          }
        },
      },
    });
    const account = await createKmsNetworkConnection(connection).getAccount(ADDRESS);
    await account.signTransaction(TRANSACTION);
    await assert.rejects(account.signTransaction({ ...TRANSACTION, chainId: 1 }));
    refuse = true;
    await assert.rejects(account.signTransaction({ ...TRANSACTION, nonce: 4 }));
    assert.deepEqual(nonceCalls, [["signed", LOWER, 3n]]);
  });

  it("refuses before asking the connection once the connection is closed", async () => {
    const { connection, nonceCalls, state } = setup();
    const account = await createKmsNetworkConnection(connection).getAccount(ADDRESS);
    state.closed = true;
    const parameters = { address: ADDRESS, chainId: CHAIN_ID, client: {} };
    for (const [operation, run] of [
      ["nonceManager.consume", async () => await account.nonceManager.consume(parameters)],
      ["nonceManager.get", async () => await account.nonceManager.get(parameters)],
    ] as const) {
      await assert.rejects(
        run,
        (error: unknown) =>
          error instanceof HardhatPluginError && error.message.startsWith(`${operation}: `),
      );
    }
    assert.deepEqual(nonceCalls, []);
  });

  it("is consumed once by viem's sendTransaction, and not reset after a send that went out", async () => {
    const { connection, nonceCalls } = setup();
    const account = await createKmsNetworkConnection(connection).getAccount(ADDRESS);
    const node = fakeNode();
    const wallet = createWalletClient({
      account,
      chain: hardhat,
      transport: custom(node.provider),
    });
    await wallet.sendTransaction({ to: TO, value: 1n });
    assert.deepEqual(
      nonceCalls.map(([method]) => method),
      ["choose", "signed"],
    );
    assert.deepEqual(nonceCalls[1], ["signed", LOWER, 7n]);
    assert.ok(!node.methods.includes("eth_getTransactionCount"), "viem read no nonce itself");
  });

  it("is reset by viem when the gas estimate fails, before anything is signed", async () => {
    const { connection, nonceCalls } = setup();
    const account = await createKmsNetworkConnection(connection).getAccount(ADDRESS);
    const node = fakeNode({ failEstimate: true });
    const wallet = createWalletClient({
      account,
      chain: hardhat,
      transport: custom(node.provider),
    });
    await assert.rejects(wallet.sendTransaction({ to: TO, value: 1n }));
    assert.deepEqual(nonceCalls, [
      ["choose", { address: LOWER, chainId: BigInt(CHAIN_ID), reserve: true, ownTransport: false }],
      ["reset", LOWER, BigInt(CHAIN_ID)],
    ]);
    assert.ok(!node.methods.includes("eth_sendRawTransaction"));
  });

  it("is not used for a send with the caller's nonce", async () => {
    const { connection, nonceCalls } = setup();
    const account = await createKmsNetworkConnection(connection).getAccount(ADDRESS);
    const node = fakeNode();
    const wallet = createWalletClient({
      account,
      chain: hardhat,
      transport: custom(node.provider),
    });
    await wallet.sendTransaction({ to: TO, value: 1n, nonce: 9 });
    assert.deepEqual(nonceCalls, [["signed", LOWER, 9n]]);
  });
});
