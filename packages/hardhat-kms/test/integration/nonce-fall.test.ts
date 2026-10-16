// Nonce choice on a real edr-simulated node after its pending count falls (#489): a dropped
// transaction, a revert to a snapshot that holds a queued transaction, and a library reservation
// that outlives a revert. The plugin must never pick a nonce the node still holds.
import assert from "node:assert/strict";
import { it } from "node:test";

import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { NetworkConnection } from "hardhat/types/network";

import hardhatKms from "../../src/index.ts";
import { fakeAdapter } from "../helpers/fake-adapter.ts";
import { vaultKey } from "../helpers/vault-key.ts";
import { COW_ACCOUNT } from "../helpers/vectors.ts";

const COW = COW_ACCOUNT.address;
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TX = { from: COW, to: TO, value: "0x0", gas: "0x5208", gasPrice: "0x3b9aca00" };

/** Opens a funded KMS account on an edr-simulated network. */
async function connect(automine: boolean): Promise<NetworkConnection> {
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKms],
    kms: { keys: { cow: vaultKey("cow") }, simulatedBalance: 10n ** 18n },
    networks: {
      local: { type: "edr-simulated", kmsAccounts: ["cow"], mining: { auto: automine } },
    },
  });
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async () =>
      fakeAdapter({ secretKey: new Uint8Array(Buffer.from(COW_ACCOUNT.secretKey, "hex")) }),
  });
  return await hre.network.create({ network: "local" });
}

/** The account's library side: a viem nonce manager on its own transport, and raw signing. */
async function library(connection: NetworkConnection) {
  const account = await connection.kms.getAccount(COW);
  const parameters = {
    address: account.address,
    chainId: 31337,
    client: { transport: { type: "http" } },
  };
  return {
    consume: async (): Promise<number> => await account.nonceManager.consume(parameters),
    /** Signs a legacy transaction with the nonce and sends it through the connection. */
    send: async (nonce: number): Promise<string> => {
      const raw = await account.signTransaction({
        type: "legacy",
        chainId: 31337,
        nonce,
        to: TO,
        value: 0n,
        gas: 21_000n,
        gasPrice: 1_000_000_000n,
      });
      return String(
        await connection.provider.request({ method: "eth_sendRawTransaction", params: [raw] }),
      );
    },
  };
}

/** Sends a transaction through the plugin and returns its hash and nonce. */
async function pluginSend(
  connection: NetworkConnection,
  fields: Record<string, string> = {},
): Promise<{ hash: string; nonce: number }> {
  const hash = String(
    await connection.provider.request({
      method: "eth_sendTransaction",
      params: [{ ...TX, ...fields }],
    }),
  );
  return { hash, nonce: await nonceOf(connection, hash) };
}

async function nonceOf(connection: NetworkConnection, hash: string): Promise<number> {
  const tx: unknown = await connection.provider.request({
    method: "eth_getTransactionByHash",
    params: [hash],
  });
  assert.ok(typeof tx === "object" && tx !== null, `the node has ${hash}`);
  return Number(Reflect.get(tx, "nonce"));
}

async function pending(connection: NetworkConnection): Promise<number> {
  return Number(
    await connection.provider.request({
      method: "eth_getTransactionCount",
      params: [COW, "pending"],
    }),
  );
}

it("after hardhat_dropTransaction, takes the dropped nonce, not one the node still holds", async () => {
  const connection = await connect(false);
  try {
    const sent = [
      await pluginSend(connection),
      await pluginSend(connection),
      await pluginSend(connection),
    ];
    assert.deepEqual(
      sent.map((tx) => tx.nonce),
      [0, 1, 2],
    );
    const lib = await library(connection);
    assert.equal(await lib.consume(), 3);
    const four = await pluginSend(connection);
    assert.equal(four.nonce, 4);
    await connection.provider.request({
      method: "hardhat_dropTransaction",
      params: [sent[1]?.hash],
    });
    assert.equal(
      await pending(connection),
      1,
      "the pending count fell, and the node holds 2 and 4",
    );
    const next = await pluginSend(connection);
    assert.equal(next.nonce, 1);
    assert.equal(await nonceOf(connection, four.hash), 4, "the transaction at 4 is not replaced");
    assert.equal(await nonceOf(connection, sent[2]?.hash ?? ""), 2);
    assert.equal((await pluginSend(connection)).nonce, 5, "3 is reserved and 4 is held");
  } finally {
    await connection.close();
  }
});

it("after evm_revert to a snapshot with a queued transaction, never takes its nonce", async () => {
  const connection = await connect(false);
  try {
    const lib = await library(connection);
    assert.equal(await lib.consume(), 0);
    const one = await pluginSend(connection);
    assert.equal(one.nonce, 1);
    const snapshot: unknown = await connection.provider.request({ method: "evm_snapshot" });
    await lib.send(0);
    assert.equal((await pluginSend(connection)).nonce, 2);
    await connection.provider.request({ method: "evm_revert", params: [snapshot] });
    assert.equal(await pending(connection), 0, "the node holds the queued 1 again");
    // The library's raw 0 went through the connection and ended its reservation.
    assert.equal(await lib.consume(), 0);
    const next = await pluginSend(connection);
    assert.equal(next.nonce, 2, "0 is reserved, and the node holds 1: the plugin skips both");
    assert.equal(await nonceOf(connection, one.hash), 1, "the queued transaction is not replaced");
  } finally {
    await connection.close();
  }
});

it("after evm_revert, plugin sends below a reservation that outlives it are mined, with no gap", async () => {
  const connection = await connect(true);
  try {
    const snapshot: unknown = await connection.provider.request({ method: "evm_snapshot" });
    for (let nonce = 0; nonce < 3; nonce++) {
      assert.equal((await pluginSend(connection)).nonce, nonce);
    }
    const lib = await library(connection);
    assert.equal(await lib.consume(), 3);
    await connection.provider.request({ method: "evm_revert", params: [snapshot] });
    assert.equal(await pending(connection), 0);
    const hashes: string[] = [];
    for (let nonce = 0; nonce < 3; nonce++) {
      const tx = await pluginSend(connection);
      assert.equal(tx.nonce, nonce);
      hashes.push(tx.hash);
    }
    for (const hash of hashes) {
      assert.ok(
        await connection.provider.request({ method: "eth_getTransactionReceipt", params: [hash] }),
        `${hash} is mined`,
      );
    }
    assert.equal(await pending(connection), 3, "no gap: the reservation's 3 is next");
    await lib.send(3);
    assert.equal((await pluginSend(connection)).nonce, 4);
    assert.equal(await pending(connection), 5, "every nonce is mined once");
  } finally {
    await connection.close();
  }
});

it("after a revert restores a dropped transaction that a second one replaced, never takes its nonce", async () => {
  const connection = await connect(false);
  try {
    for (let nonce = 0; nonce < 3; nonce++) {
      assert.equal((await pluginSend(connection)).nonce, nonce);
    }
    const lib = await library(connection);
    assert.equal(await lib.consume(), 3);
    const first = await pluginSend(connection);
    assert.equal(first.nonce, 4);
    const snapshot: unknown = await connection.provider.request({ method: "evm_snapshot" });
    await connection.provider.request({ method: "hardhat_dropTransaction", params: [first.hash] });
    const second = await pluginSend(connection, { value: "0x1" });
    assert.equal(second.nonce, 4, "the node lacks 4");
    await connection.provider.request({ method: "evm_revert", params: [snapshot] });
    const next = await pluginSend(connection, { gasPrice: "0x77359400" });
    assert.equal(next.nonce, 5, "the restored transaction at 4 still counts");
    assert.equal(await nonceOf(connection, first.hash), 4, "it is not replaced");
  } finally {
    await connection.close();
  }
});

it("after a revert restores a transaction that a caller-nonce replacement replaced, never takes its nonce", async () => {
  const connection = await connect(false);
  try {
    const lib = await library(connection);
    assert.equal(await lib.consume(), 0);
    const original = await pluginSend(connection);
    assert.equal(original.nonce, 1);
    const snapshot: unknown = await connection.provider.request({ method: "evm_snapshot" });
    const replacement = await pluginSend(connection, { nonce: "0x1", gasPrice: "0x77359400" });
    assert.equal(replacement.nonce, 1);
    await connection.provider.request({ method: "evm_revert", params: [snapshot] });
    // The replacement's nonce ended the reservation of 0; the library client takes 0 again.
    assert.equal(await lib.consume(), 0);
    const next = await pluginSend(connection, { gasPrice: "0xb2d05e00" });
    assert.equal(next.nonce, 2, "the restored transaction at 1 still counts");
    assert.equal(await nonceOf(connection, original.hash), 1, "it is not replaced");
  } finally {
    await connection.close();
  }
});
