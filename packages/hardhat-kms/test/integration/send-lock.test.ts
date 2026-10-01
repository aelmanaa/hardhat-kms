// Parallel sends, the nonce high-water mark and retries after broadcast, end to end: on a
// simulated network, and with viem over HTTP against a recording node.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { keccak_256 } from "@noble/hashes/sha3.js";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import { Transaction } from "micro-eth-signer";
import { getAddress } from "viem";

import hardhatKms from "../../src/index.ts";
import { sendLocksInUse } from "../../src/internal/rpc/send-guard.ts";
import type { KmsKeyUserConfig } from "../../src/types.ts";
import { fakeAdapter } from "../helpers/fake-adapter.ts";
import { type RecordingNode, startRecordingNode } from "../helpers/recording-node.ts";
import { COW_ACCOUNT, HARDHAT_ACCOUNT_0 } from "../helpers/vectors.ts";

const COW = getAddress(COW_ACCOUNT.address);
const ZERO = getAddress(HARDHAT_ACCOUNT_0.address);
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SECRETS: Record<string, string> = {
  cow: COW_ACCOUNT.secretKey,
  zero: HARDHAT_ACCOUNT_0.secretKey,
};
const N = 10;

/** The configs of the fake third-party keys, by name. */
function vaultKeys(): Record<string, KmsKeyUserConfig> {
  return Object.fromEntries(
    Object.keys(SECRETS).map((name) => {
      const key: unknown = { provider: "myvault", name };
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a third-party provider's key
      return [name, key as KmsKeyUserConfig];
    }),
  );
}

/** Serves the fake adapters through the `kms` hook. */
function serveAdapters(hre: HardhatRuntimeEnvironment): void {
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async (context, key, next) => {
      const secret = SECRETS[key.name];
      return secret === undefined
        ? await next(context, key)
        : fakeAdapter({ secretKey: new Uint8Array(Buffer.from(secret, "hex")) });
    },
  });
}

/** Fails the test instead of hanging when `promise` takes longer than `ms`. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} did not finish within ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const hashOf = (raw: string): string =>
  `0x${Buffer.from(keccak_256(Buffer.from(raw.slice(2), "hex"))).toString("hex")}`;

describe("parallel sends on a simulated network", () => {
  it(`mines ${N} parallel sends from one account with nonces 0 to ${N - 1}, and signs meanwhile`, async () => {
    const hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKms],
      kms: { keys: vaultKeys(), simulatedBalance: 10n ** 18n },
      networks: { local: { type: "edr-simulated", kmsAccounts: ["cow", "zero"] } },
    });
    serveAdapters(hre);
    const { provider } = await hre.network.create("local");
    const send = async (from: string): Promise<unknown> =>
      await provider.request({
        method: "eth_sendTransaction",
        params: [{ from, to: TO, value: "0x1" }],
      });
    const [cowHashes, zeroHashes, signed] = await within(
      Promise.all([
        Promise.all(Array.from({ length: N }, async () => await send(COW))),
        Promise.all(Array.from({ length: N }, async () => await send(ZERO))),
        provider.request({ method: "eth_signTransaction", params: [{ from: COW, to: TO }] }),
      ]),
      60_000,
      "the parallel sends",
    );
    assert.ok(typeof signed === "string");
    assert.equal(Transaction.fromHex(signed, false).sender, COW);

    for (const [from, hashes] of [
      [COW, cowHashes],
      [ZERO, zeroHashes],
    ] as const) {
      const nonces: bigint[] = [];
      for (const hash of hashes) {
        const receipt: unknown = await provider.request({
          method: "eth_getTransactionReceipt",
          params: [hash],
        });
        assert.ok(typeof receipt === "object" && receipt !== null);
        assert.equal(Reflect.get(receipt, "status"), "0x1");
        const tx: unknown = await provider.request({
          method: "eth_getTransactionByHash",
          params: [hash],
        });
        assert.ok(typeof tx === "object" && tx !== null);
        assert.equal(getAddress(String(Reflect.get(tx, "from"))), from);
        nonces.push(BigInt(String(Reflect.get(tx, "nonce"))));
      }
      assert.deepEqual(
        nonces.toSorted((a, b) => (a < b ? -1 : 1)),
        Array.from({ length: N }, (_, i) => BigInt(i)),
      );
    }
    assert.equal(sendLocksInUse(), 0);
  });
});

describe("sends over HTTP to a node", () => {
  let node: RecordingNode;
  let hre: HardhatRuntimeEnvironment;

  before(async () => {
    node = await startRecordingNode();
    hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKms, hardhatViem],
      kms: { keys: vaultKeys() },
      networks: {
        remote: {
          type: "http",
          url: node.url,
          chainId: 31337,
          kmsAccounts: ["cow"],
          timeout: 1000,
        },
      },
    });
    serveAdapters(hre);
  });

  after(async () => {
    await node.server.close();
  });

  it("does not reuse a nonce when the node's pending count lags", async () => {
    // The recording node never runs the transactions, so its pending count stays at 0.
    const { provider } = await hre.network.create("remote");
    const start = node.raw.length;
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        await provider.request({ method: "eth_sendTransaction", params: [{ from: COW, to: TO }] });
      }),
    );
    await provider.request({ method: "eth_sendTransaction", params: [{ from: COW, to: TO }] });
    assert.deepEqual(
      node.raw.slice(start).map((raw) => Transaction.fromHex(raw, false).raw.nonce),
      [0n, 1n, 2n, 3n],
    );
  });

  it("does not broadcast twice when the broadcast times out under viem", async () => {
    const connection = await hre.network.create("remote");
    const wallet = await connection.viem.getWalletClient(COW);
    const start = node.raw.length;
    // The node accepts the transaction, then answers after the client's 1 s timeout.
    node.afterAccept = { delayMs: 1500 };
    try {
      await assert.rejects(wallet.sendTransaction({ to: getAddress(TO), value: 1n }), (error) => {
        const text = String(error);
        assert.match(text, /was handed to the node, but the send failed/);
        assert.match(text, /HardhatError was thrown/);
        return true;
      });
    } finally {
      node.afterAccept = undefined;
    }
    assert.equal(node.raw.length, start + 1, "viem did not retry, and nothing was sent again");
  });

  it("sends the same bytes again for a retried request, and returns the same hash", async () => {
    const { provider } = await hre.network.create("remote");
    const request = {
      method: "eth_sendTransaction",
      params: [{ from: COW, to: TO, value: "0x5" }],
    };
    const start = node.raw.length;
    node.afterAccept = { error: "upstream timeout" };
    let hash: unknown;
    try {
      await assert.rejects(provider.request(structuredClone(request)), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(Reflect.get(error, "code"), -32000);
        const data: unknown = Reflect.get(error, "data");
        assert.ok(typeof data === "object" && data !== null);
        hash = Reflect.get(data, "hash");
        return true;
      });
    } finally {
      node.afterAccept = undefined;
    }
    const sent = node.raw.slice(start);
    assert.equal(sent.length, 1);
    assert.equal(hash, hashOf(sent[0] ?? ""));
    assert.equal(await provider.request(structuredClone(request)), hash);
    assert.deepEqual(node.raw.slice(start), [sent[0], sent[0]], "the same bytes, sent again");
  });
});
