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
import { SendOutcomeUnknownError, sendLocksInUse } from "../../src/internal/rpc/send-guard.ts";
import type { KmsKeyUserConfig } from "../../src/types.ts";
import { fakeAdapter } from "../helpers/fake-adapter.ts";
import { type RecordingNode, startRecordingNode } from "../helpers/recording-node.ts";
import { vaultKey } from "../helpers/vault-key.ts";
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
  return Object.fromEntries(Object.keys(SECRETS).map((name) => [name, vaultKey(name)]));
}

/** Serves the fake adapters through the `kms` hook, and counts their signatures. */
function serveAdapters(hre: HardhatRuntimeEnvironment): { signatures: number } {
  const counts = { signatures: 0 };
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async (context, key, next) => {
      const secret = SECRETS[key.name];
      return secret === undefined
        ? await next(context, key)
        : fakeAdapter({
            secretKey: new Uint8Array(Buffer.from(secret, "hex")),
            beforeSign: async () => {
              counts.signatures++;
              await Promise.resolve();
            },
          });
    },
  });
  return counts;
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

describe("a reverted send on a simulated network", () => {
  // Creation code that reverts with the bytes 0xdeadbeef.
  const REVERTING = "0x63deadbeef60e01b60005260046000fd";

  it("throws the node's revert error unchanged, with its data and transaction hash", async () => {
    const hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKms],
      kms: { keys: vaultKeys(), simulatedBalance: 10n ** 18n },
      networks: { local: { type: "edr-simulated", kmsAccounts: ["cow"] } },
    });
    const counts = serveAdapters(hre);
    const { provider } = await hre.network.create("local");
    // An explicit gas limit, so the estimate does not fail first.
    const request = {
      method: "eth_sendTransaction",
      params: [{ from: COW, data: REVERTING, gas: "0x30000" }],
    };
    const hashes: unknown[] = [];
    for (let i = 0; i < 2; i++) {
      await assert.rejects(provider.request(structuredClone(request)), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "SolidityError");
        assert.equal(Reflect.get(error, "code"), 3);
        assert.equal(Reflect.get(error, "data"), "0xdeadbeef");
        hashes.push(Reflect.get(error, "transactionHash"));
        return true;
      });
    }
    assert.equal(counts.signatures, 2, "no retry entry: the second request was signed again");
    for (const [nonce, hash] of hashes.entries()) {
      assert.ok(typeof hash === "string");
      const receipt: unknown = await provider.request({
        method: "eth_getTransactionReceipt",
        params: [hash],
      });
      assert.ok(typeof receipt === "object" && receipt !== null);
      assert.equal(Reflect.get(receipt, "status"), "0x0", "mined and reverted");
      const tx: unknown = await provider.request({
        method: "eth_getTransactionByHash",
        params: [hash],
      });
      assert.ok(typeof tx === "object" && tx !== null);
      assert.equal(BigInt(String(Reflect.get(tx, "nonce"))), BigInt(nonce));
    }
  });
});

describe("a re-entrant send on a simulated network", () => {
  it("fails a send that a hook makes from the same account during the fill, and mines the outer send", async () => {
    const hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKms],
      kms: { keys: vaultKeys(), simulatedBalance: 10n ** 18n },
      networks: { local: { type: "edr-simulated", kmsAccounts: ["cow", "zero"] } },
    });
    const counts = serveAdapters(hre);
    const inner: { cow?: unknown; zero?: unknown } = {};
    let estimates = 0;
    hre.hooks.registerHandlers("network", {
      onRequest: async (context, connection, request, next) => {
        if (request.method === "eth_estimateGas" && estimates++ === 0) {
          // Runs inside the outer send's lock: the same account must fail fast, another works.
          await connection.provider
            .request({
              method: "eth_sendTransaction",
              params: [{ from: COW, to: TO, value: "0x2" }],
            })
            .catch((error: unknown) => {
              inner.cow = error;
            });
          inner.zero = await connection.provider.request({
            method: "eth_sendTransaction",
            params: [{ from: ZERO, to: TO, value: "0x3" }],
          });
        }
        return await next(context, connection, request);
      },
    });
    const { provider } = await hre.network.create("local");
    const hash = await within(
      provider.request({
        method: "eth_sendTransaction",
        params: [{ from: COW, to: TO, value: "0x1" }],
      }),
      30_000,
      "the outer send",
    );
    assert.ok(inner.cow instanceof Error, "the re-entrant send failed");
    assert.match(
      inner.cow.message,
      new RegExp(`${COW.toLowerCase()} on chain 31337 was made from inside an earlier send`, "i"),
    );
    assert.match(inner.cow.message, /not signed or sent/);
    assert.doesNotMatch(inner.cow.message, /myvault|cow\b/);
    assert.equal(counts.signatures, 2, "the outer send and the other account's send were signed");
    for (const sent of [hash, inner.zero]) {
      const receipt: unknown = await provider.request({
        method: "eth_getTransactionReceipt",
        params: [sent],
      });
      assert.ok(typeof receipt === "object" && receipt !== null);
      assert.equal(Reflect.get(receipt, "status"), "0x1");
    }
    assert.equal(sendLocksInUse(), 0);
  });
});

describe("sends over HTTP to a node", () => {
  let node: RecordingNode;
  let hre: HardhatRuntimeEnvironment;
  let counts: { signatures: number };

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
    counts = serveAdapters(hre);
  });

  after(async () => {
    await node.server.close();
  });

  it("keeps an explicit nonce and sends same-nonce replacements with higher fees", async () => {
    // Ignition's fee bumps: the same nonce, sent again through eth_sendTransaction with higher fees.
    const { provider } = await hre.network.create("remote");
    const start = node.raw.length;
    const fees = [
      { maxFeePerGas: "0x3b9aca00", maxPriorityFeePerGas: "0x1" },
      { maxFeePerGas: "0x77359400", maxPriorityFeePerGas: "0x2" },
    ];
    const hashes: unknown[] = [];
    for (const fee of fees) {
      hashes.push(
        await provider.request({
          method: "eth_sendTransaction",
          params: [{ from: COW, to: TO, nonce: "0x9", ...fee }],
        }),
      );
    }
    const sent = node.raw.slice(start).map((raw) => Transaction.fromHex(raw, false).raw);
    assert.deepEqual(
      sent.map((tx) => tx.nonce),
      [9n, 9n],
    );
    assert.deepEqual(
      sent.map((tx): unknown => Reflect.get(tx, "maxFeePerGas")),
      fees.map((fee) => BigInt(fee.maxFeePerGas)),
    );
    assert.notEqual(hashes[0], hashes[1]);
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
        assert.match(text, /was handed to the node, but no answer came back/);
        assert.match(text, /\(HardhatError\)/);
        return true;
      });
    } finally {
      node.afterAccept = undefined;
    }
    assert.equal(node.raw.length, start + 1, "viem did not retry, and nothing was sent again");
  });

  it("passes a node's refusal through unchanged and keeps no retry entry", async () => {
    const { provider } = await hre.network.create("remote");
    const request = {
      method: "eth_sendTransaction",
      params: [{ from: COW, to: TO, value: "0x6" }],
    };
    const signatures = counts.signatures;
    node.afterAccept = { error: "nonce too low" };
    try {
      for (let i = 0; i < 2; i++) {
        await assert.rejects(provider.request(structuredClone(request)), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, "nonce too low");
          assert.equal(Reflect.get(error, "code"), -32000);
          return true;
        });
      }
    } finally {
      node.afterAccept = undefined;
    }
    assert.equal(counts.signatures, signatures + 2, "each request was signed");
  });

  it("passes a gateway's timeout answer through, and the retry sends the same bytes", async () => {
    const { provider } = await hre.network.create("remote");
    const request = {
      method: "eth_sendTransaction",
      params: [{ from: COW, to: TO, value: "0x7" }],
    };
    const start = node.raw.length;
    const signatures = counts.signatures;
    // The gateway forwarded the transaction, then gave up waiting for its backend.
    node.afterAccept = { error: "upstream request timeout", code: -32603 };
    try {
      await assert.rejects(provider.request(structuredClone(request)), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "upstream request timeout");
        assert.equal(Reflect.get(error, "code"), -32603);
        return true;
      });
    } finally {
      node.afterAccept = undefined;
    }
    const hash = await provider.request(structuredClone(request));
    const sent = node.raw.slice(start);
    assert.deepEqual(sent, [sent[0], sent[0]], "the same bytes, sent again");
    assert.equal(hash, hashOf(sent[0] ?? ""));
    assert.equal(counts.signatures, signatures + 1);
  });

  it("sends the same bytes again for a retried request, and returns the same hash", async () => {
    const { provider } = await hre.network.create("remote");
    const request = {
      method: "eth_sendTransaction",
      params: [{ from: COW, to: TO, value: "0x5" }],
    };
    const start = node.raw.length;
    const signatures = counts.signatures;
    // The node accepts the transaction, then answers after the client's 1 s timeout.
    node.afterAccept = { delayMs: 1500 };
    let hash: unknown;
    try {
      await assert.rejects(provider.request(structuredClone(request)), (error: unknown) => {
        assert.ok(error instanceof SendOutcomeUnknownError, String(error));
        assert.equal(error.code, -32000);
        assert.equal(error.data.hash, error.transactionHash);
        hash = error.transactionHash;
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
    assert.equal(counts.signatures, signatures + 1, "the retry was not signed again");
  });
});
