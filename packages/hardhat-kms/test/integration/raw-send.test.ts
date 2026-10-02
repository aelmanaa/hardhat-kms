// A connection.kms.getAccount account and the plugin sending from one KMS address at the same time,
// on an edr-simulated network: viem fills the account's nonce and sends eth_sendRawTransaction
// through the connection, and the plugin orders it with its own sends. EDR holds none of the keys.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import hardhatViem from "@nomicfoundation/hardhat-viem";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatPlugin } from "hardhat/types/plugins";
import { Transaction } from "micro-eth-signer";
import { createWalletClient, custom, getAddress, type Hex, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";

import hardhatKms from "../../src/index.ts";
import { createNetworkHandlers } from "../../src/internal/hook-handlers/network.ts";
import { sendLocksInUse } from "../../src/internal/rpc/send-guard.ts";
import { addressOfSecretKey, fakeAdapter } from "../helpers/fake-adapter.ts";
import { startRecordingNode } from "../helpers/recording-node.ts";
import { vaultKey } from "../helpers/vault-key.ts";
import { COW_ACCOUNT } from "../helpers/vectors.ts";

const secretKey = new Uint8Array(Buffer.from(COW_ACCOUNT.secretKey, "hex"));
const COW = getAddress(addressOfSecretKey(secretKey));
const TO = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
/** Hardhat's second default account, which EDR holds; not a KMS account. */
const OTHER = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const ROUNDS = 10;

/** The plugin with the nonce high-water mark on for edr-simulated networks too. */
const withHighWater: HardhatPlugin = {
  ...hardhatKms,
  hookHandlers: {
    ...hardhatKms.hookHandlers,
    network: async () =>
      await Promise.resolve({
        default: async () =>
          await Promise.resolve(createNetworkHandlers(undefined, undefined, true)),
      }),
  },
};

/**
 * A runtime with one KMS account. Each KMS signature waits a few milliseconds, as a cloud KMS
 * takes time, so the two sends overlap.
 */
async function runtime(kms: HardhatPlugin) {
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [kms, hardhatViem],
    kms: { keys: { cow: vaultKey("cow") }, simulatedBalance: 10n ** 18n },
    networks: { local: { type: "edr-simulated", kmsAccounts: ["cow"] } },
  });
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async () =>
      await Promise.resolve(
        fakeAdapter({
          secretKey,
          beforeSign: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
          },
        }),
      ),
  });
  return hre;
}

/** Reads a mined transaction's sender, nonce and status. */
async function minedOf(
  publicClient: Awaited<ReturnType<typeof viemOf>>,
  hash: Hex,
): Promise<{ from: string; nonce: number }> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success");
  const transaction = await publicClient.getTransaction({ hash });
  return { from: getAddress(transaction.from), nonce: transaction.nonce };
}

async function viemOf(connection: Awaited<ReturnType<typeof connect>>) {
  return await connection.viem.getPublicClient();
}

async function connect(kms: HardhatPlugin) {
  const hre = await runtime(kms);
  return await hre.network.create({ network: "local" });
}

describe("a library account's send next to the plugin's sends", { timeout: 300_000 }, () => {
  for (const [name, kms] of [
    ["with the high-water mark on", withHighWater],
    ["with the high-water mark off, as by default", hardhatKms],
  ] as const) {
    for (const libraryFirst of [true, false]) {
      it(`${name}, ${libraryFirst ? "library account first" : "plugin first"}: both mine with distinct nonces, ${ROUNDS} times`, async () => {
        for (let round = 0; round < ROUNDS; round++) {
          // Each connection to an edr-simulated network starts a new chain at nonce 0.
          const connection = await connect(kms);
          const account = await connection.kms.getAccount(COW);
          const library = createWalletClient({
            account,
            chain: hardhat,
            transport: custom(connection.provider),
          });
          const plugin = await connection.viem.getWalletClient(COW);
          const sends = [
            async () => await library.sendTransaction({ to: TO, value: 1n }),
            async () => await plugin.sendTransaction({ to: TO, value: 2n }),
          ];
          if (!libraryFirst) {
            sends.reverse();
          }
          const hashes = await Promise.all(sends.map(async (send) => await send()));
          const publicClient = await viemOf(connection);
          const mined = await Promise.all(
            hashes.map(async (hash) => await minedOf(publicClient, hash)),
          );
          assert.deepEqual(
            mined.map(({ from }) => from),
            [COW, COW],
          );
          assert.deepEqual(
            mined.map(({ nonce }) => nonce).toSorted((a, b) => a - b),
            [0, 1],
            `round ${round}: distinct nonces`,
          );
          assert.equal(sendLocksInUse(), 0);
          await connection.close();
        }
      });
    }
  }

  it("passes another sender's raw transaction through, and a re-broadcast of the account's", async () => {
    const connection = await connect(withHighWater);
    const transport = custom(connection.provider);
    const other = createWalletClient({ account: OTHER, chain: hardhat, transport });
    const publicClient = await viemOf(connection);
    const otherHash = await other.sendTransaction({ to: TO, value: 3n });
    assert.equal((await minedOf(publicClient, otherHash)).from, OTHER.address);

    const library = createWalletClient({
      account: await connection.kms.getAccount(COW),
      chain: hardhat,
      transport,
    });
    const request = await library.prepareTransactionRequest({ to: TO, value: 4n });
    const raw = await library.signTransaction(request);
    const send = async (): Promise<unknown> =>
      await connection.provider.request({ method: "eth_sendRawTransaction", params: [raw] });
    const hash = await send();
    assert.ok(isHex(hash));
    assert.equal((await minedOf(publicClient, hash)).nonce, 0);
    // EDR mined it, so it refuses the same bytes, as it does another sender's; nothing hangs.
    await assert.rejects(send(), /nonce/i);
    const otherRaw = await other.signTransaction(
      await other.prepareTransactionRequest({ to: TO, value: 3n, nonce: 0 }),
    );
    await assert.rejects(
      connection.provider.request({ method: "eth_sendRawTransaction", params: [otherRaw] }),
      /nonce/i,
    );
    assert.equal(sendLocksInUse(), 0);
    // The plugin's next send takes the next nonce.
    const plugin = await connection.viem.getWalletClient(COW);
    const next = await plugin.sendTransaction({ to: TO, value: 5n });
    assert.equal((await minedOf(publicClient, next)).nonce, 1);
    await connection.close();
  });

  it("fails a library account's send from inside a plugin send from the same account, and mines the outer send", async () => {
    const hre = await runtime(withHighWater);
    let inner: unknown;
    let estimates = 0;
    hre.hooks.registerHandlers("network", {
      onRequest: async (context, connection, request, next) => {
        if (request.method === "eth_estimateGas" && estimates++ === 0) {
          // Runs inside the outer send's lock.
          const library = createWalletClient({
            account: await connection.kms.getAccount(COW),
            chain: hardhat,
            transport: custom(connection.provider),
          });
          inner = await library
            .sendTransaction({ to: TO, value: 6n, gas: 21_000n })
            .catch((error: unknown) => error);
        }
        return await next(context, connection, request);
      },
    });
    const connection = await hre.network.create({ network: "local" });
    const plugin = await connection.viem.getWalletClient(COW);
    const hash = await plugin.sendTransaction({ to: TO, value: 7n });
    assert.equal((await minedOf(await viemOf(connection), hash)).nonce, 0);
    assert.ok(inner instanceof Error);
    assert.match(
      String(inner),
      /raw transaction from 0x[0-9a-f]{40} on chain 31337 was sent from inside/,
    );
    assert.equal(sendLocksInUse(), 0);
    await connection.close();
  });

  it(`on a node whose pending count lags, keeps ${ROUNDS} rounds of parallel sends on distinct nonces`, async () => {
    // The recording node never runs the transactions, so its pending count stays at 0: only the
    // plugin's high-water mark, which raw transactions now raise, keeps the nonces apart.
    const node = await startRecordingNode();
    try {
      const hre = await createHardhatRuntimeEnvironment({
        plugins: [hardhatKms, hardhatViem],
        kms: { keys: { cow: vaultKey("cow") } },
        networks: {
          remote: { type: "http", url: node.url, chainId: 31337, kmsAccounts: ["cow"] },
        },
      });
      hre.hooks.registerHandlers("kms", {
        createKeyAdapter: async () => await Promise.resolve(fakeAdapter({ secretKey })),
      });
      const connection = await hre.network.create({ network: "remote" });
      const library = createWalletClient({
        account: await connection.kms.getAccount(COW),
        chain: hardhat,
        transport: custom(connection.provider),
      });
      const plugin = await connection.viem.getWalletClient(COW);
      for (let round = 0; round < ROUNDS; round++) {
        await Promise.all([
          library.sendTransaction({ to: TO, value: 0n }),
          plugin.sendTransaction({ to: TO, value: 0n }),
        ]);
      }
      const nonces = node.raw.map((raw) => Number(Transaction.fromHex(raw, false).raw.nonce));
      assert.deepEqual(
        nonces.toSorted((a, b) => a - b),
        Array.from({ length: 2 * ROUNDS }, (_, i) => i),
      );
      assert.equal(sendLocksInUse(), 0);
      await connection.close();
    } finally {
      await node.server.close();
    }
  });
});
