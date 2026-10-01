import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HardhatPluginError } from "hardhat/plugins";
import { addr, Transaction } from "micro-eth-signer";

import {
  buildUnsignedTransaction,
  type FilledTransaction,
  type FillSettings,
  HardhatTransactionFiller,
  signingHash,
  type UnsignedTransaction,
} from "../../../src/internal/rpc/transaction-filler.ts";
import { HARDHAT_ACCOUNT_0 } from "../../helpers/vectors.ts";

const FROM = HARDHAT_ACCOUNT_0.address;
const TO = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const CHAIN = 31337n;

type Answer = unknown;
type Handler = (params: unknown[] | undefined) => Answer;

/** A fake node: answers by method, records every call, throws for unknown methods. */
function fakeNode(handlers: Record<string, Handler>) {
  const calls: { method: string; params: unknown[] | undefined }[] = [];
  const request = async (method: string, params?: unknown[]): Promise<unknown> => {
    // A copy: the filler goes on to fill the transaction it sent for the estimate.
    calls.push({ method, params: structuredClone(params) });
    const handler = handlers[method];
    if (handler === undefined) {
      throw new Error(`unexpected ${method}`);
    }
    return await Promise.resolve(handler(params));
  };
  const methods = () => calls.map((call) => call.method);
  return { request, calls, methods };
}

/** A node with EIP-1559 fees, a 30M block gas limit and an estimate of 21000. */
const EIP1559_NODE: Record<string, Handler> = {
  eth_getBlockByNumber: () => ({ baseFeePerGas: "0x10", gasLimit: "0x1c9c380" }),
  eth_feeHistory: () => ({ baseFeePerGas: ["0x8", "0x40"], reward: [["0x2"]] }),
  eth_estimateGas: () => "0x5208",
  eth_getTransactionCount: () => "0x7",
  eth_gasPrice: () => "0x64",
};

const AUTO: FillSettings = {
  gas: "auto",
  gasPrice: "auto",
  gasMultiplier: 1,
  fallbackGas: undefined,
  isBlockGasLimitEnforced: () => true,
};

function filler(handlers: Record<string, Handler>, settings: Partial<FillSettings> = {}) {
  const node = fakeNode(handlers);
  const instance = new HardhatTransactionFiller(
    node.request,
    async () => await Promise.resolve(CHAIN),
    { ...AUTO, ...settings },
  );
  return { node, filler: instance };
}

async function fill(
  handlers: Record<string, Handler>,
  tx: Record<string, unknown>,
  settings: Partial<FillSettings> = {},
) {
  const { node, filler: instance } = filler(handlers, settings);
  const filled = await instance.fill("eth_sendTransaction", [{ from: FROM, to: TO, ...tx }]);
  return { node, filled };
}

async function assertKmsError(promise: Promise<unknown>, includes: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HardhatPluginError, String(error));
    assert.ok(error.message.includes(includes), error.message);
    return true;
  });
}

/** The EIP-1559 node, with an estimate that fails. */
function throwing(error: Error): Record<string, Handler> {
  return {
    ...EIP1559_NODE,
    eth_estimateGas: () => {
      throw error;
    },
  };
}

/** An error shaped like Hardhat's InternalCallOutOfGasError. */
function outOfGas(options: { name?: string; code?: number; reason?: string } = {}): Error {
  const error = new Error("Gas estimation failed: an internal call runs out of gas");
  error.name = options.name ?? "InternalCallOutOfGasError";
  return Object.assign(error, {
    code: options.code ?? -32000,
    data: options.reason === undefined ? undefined : { reason: options.reason },
  });
}

describe("HardhatTransactionFiller copies", () => {
  it("leaves the caller's transaction and its lists unchanged", async () => {
    const accessList = [{ address: TO, storageKeys: [] }];
    const tx = { from: FROM, to: TO, accessList };
    const { filler: instance } = filler(EIP1559_NODE);
    await instance.fill("eth_sendTransaction", [tx]);
    assert.deepEqual(tx, { from: FROM, to: TO, accessList: [{ address: TO, storageKeys: [] }] });
    assert.equal(tx.accessList, accessList);
  });

  it("refuses a transaction that is not plain data", async () => {
    const { node, filler: instance } = filler(EIP1559_NODE);
    await assertKmsError(
      instance.fill("eth_sendTransaction", [{ from: FROM, to: TO, data: () => "0x" }]),
      "the transaction must be plain data",
    );
    assert.deepEqual(node.methods(), []);
  });
});

describe("HardhatTransactionFiller fees", () => {
  it("suggests EIP-1559 fees from eth_feeHistory", async () => {
    const { node, filled } = await fill(EIP1559_NODE, {});
    // 0x40 * 9^2 / 8^2 = 81
    assert.equal(filled.maxFeePerGas, 81n);
    assert.equal(filled.maxPriorityFeePerGas, 2n);
    assert.equal(filled.gasPrice, undefined);
    assert.deepEqual(node.calls[1], {
      method: "eth_feeHistory",
      params: ["0x1", "latest", [50]],
    });
    // The estimate sees the filled fees.
    assert.deepEqual(node.calls[2]?.params, [
      { from: FROM, to: TO, maxFeePerGas: "0x51", maxPriorityFeePerGas: "0x2" },
    ]);
  });

  it("asks eth_maxPriorityFeePerGas when the median reward is 0", async () => {
    const zero = {
      ...EIP1559_NODE,
      eth_feeHistory: () => ({ baseFeePerGas: ["0x8"], reward: [["0x0"]] }),
    };
    const suggested = await fill({ ...zero, eth_maxPriorityFeePerGas: () => "0x5" }, {});
    assert.equal(suggested.filled.maxPriorityFeePerGas, 5n);
    const missing = await fill(zero, {});
    assert.equal(missing.filled.maxPriorityFeePerGas, 1n);
    const stillZero = await fill({ ...zero, eth_maxPriorityFeePerGas: () => "0x0" }, {});
    assert.equal(stillZero.filled.maxPriorityFeePerGas, 1n);
    assert.equal(stillZero.filled.maxFeePerGas, 10n);
  });

  it("sends a legacy gas price to a node without a base fee, and remembers it", async () => {
    const { node, filler: instance } = filler({
      ...EIP1559_NODE,
      eth_getBlockByNumber: () => ({ gasLimit: "0x1c9c380" }),
    });
    const first = await instance.fill("eth_sendTransaction", [{ from: FROM, to: TO }]);
    await instance.fill("eth_sendTransaction", [{ from: FROM, to: TO }]);
    assert.equal(first.gasPrice, 100n);
    assert.equal(first.maxFeePerGas, undefined);
    assert.equal(node.methods().filter((method) => method === "eth_getBlockByNumber").length, 1);
    assert.ok(!node.methods().includes("eth_feeHistory"));
  });

  it("falls back to a legacy gas price when eth_feeHistory fails, and remembers it", async () => {
    for (const history of [
      () => {
        throw new Error("method not found");
      },
      () => ({ baseFeePerGas: "0x1", reward: [] }),
      () => null,
      () => ({ baseFeePerGas: ["0x1"], reward: [] }),
    ]) {
      const { node, filler: instance } = filler({ ...EIP1559_NODE, eth_feeHistory: history });
      const first = await instance.fill("eth_sendTransaction", [{ from: FROM, to: TO }]);
      await instance.fill("eth_sendTransaction", [{ from: FROM, to: TO }]);
      assert.equal(first.gasPrice, 100n);
      assert.equal(node.methods().filter((method) => method === "eth_feeHistory").length, 1);
    }
  });

  it("uses the gas price for both EIP-1559 fields when eth_feeHistory fails but one is given", async () => {
    const failing = {
      ...EIP1559_NODE,
      eth_feeHistory: () => {
        throw new Error("method not found");
      },
    };
    const priority = await fill(failing, { maxPriorityFeePerGas: "0x3" });
    assert.equal(priority.filled.maxFeePerGas, 100n);
    assert.equal(priority.filled.maxPriorityFeePerGas, 3n);
    const max = await fill(failing, { maxFeePerGas: "0x3" });
    // maxFeePerGas below the priority fee gets the priority fee added.
    assert.equal(max.filled.maxFeePerGas, 103n);
    assert.equal(max.filled.maxPriorityFeePerGas, 100n);
  });

  it("keeps the caller's fees", async () => {
    const legacy = await fill(EIP1559_NODE, { gasPrice: "0x9" });
    assert.equal(legacy.filled.gasPrice, 9n);
    assert.ok(!legacy.node.methods().includes("eth_feeHistory"));
    const both = await fill(EIP1559_NODE, { maxFeePerGas: "0x9", maxPriorityFeePerGas: "0x1" });
    assert.equal(both.filled.maxFeePerGas, 9n);
    assert.ok(!both.node.methods().includes("eth_getBlockByNumber"));
    const raised = await fill(EIP1559_NODE, { maxFeePerGas: "0x1" });
    assert.equal(raised.filled.maxFeePerGas, 3n);
    assert.equal(raised.filled.maxPriorityFeePerGas, 2n);
  });

  it("keeps a maxFeePerGas equal to the priority fee", async () => {
    const { filled } = await fill(
      {
        ...EIP1559_NODE,
        eth_feeHistory: () => {
          throw new Error("method not found");
        },
        eth_gasPrice: () => "0x2",
      },
      { maxFeePerGas: "0x2" },
    );
    assert.equal(filled.maxFeePerGas, 2n);
    assert.equal(filled.maxPriorityFeePerGas, 2n);
  });

  it("replaces a fee that is not a string, as Hardhat does", async () => {
    const { filled } = await fill(EIP1559_NODE, { maxFeePerGas: 5n });
    assert.equal(filled.maxFeePerGas, 81n);
  });

  it("uses a fixed gas price when the network sets one", async () => {
    const fixed = await fill(EIP1559_NODE, {}, { gasPrice: 7n });
    assert.equal(fixed.filled.gasPrice, 7n);
    assert.ok(!fixed.node.methods().includes("eth_feeHistory"));
    await assertKmsError(
      fill(EIP1559_NODE, { maxPriorityFeePerGas: "0x1" }, { gasPrice: 7n }),
      "has maxPriorityFeePerGas but no maxFeePerGas",
    );
    await assertKmsError(
      fill(EIP1559_NODE, { maxFeePerGas: "0x1" }, { gasPrice: 7n }),
      "has maxFeePerGas but no maxPriorityFeePerGas",
    );
  });

  it("refuses a latest block that is not an object", async () => {
    await assertKmsError(
      fill({ ...EIP1559_NODE, eth_getBlockByNumber: () => null }, {}),
      "eth_getBlockByNumber: the node returned no latest block",
    );
  });

  it("refuses a gas price that is not a string", async () => {
    await assertKmsError(
      fill({ ...EIP1559_NODE, eth_getBlockByNumber: () => ({}), eth_gasPrice: () => 1 }, {}),
      "eth_gasPrice: the node's eth_gasPrice answer is not a string",
    );
  });
});

describe("HardhatTransactionFiller gas", () => {
  it("uses the estimate as is with a multiplier of 1", async () => {
    const { filled } = await fill(EIP1559_NODE, {});
    assert.equal(filled.gas, 21000n);
  });

  it("keeps the caller's gas, and uses a fixed gas when the network sets one", async () => {
    const given = await fill(EIP1559_NODE, { gas: "0x6000" });
    assert.equal(given.filled.gas, 0x6000n);
    assert.ok(!given.node.methods().includes("eth_estimateGas"));
    const fixed = await fill(EIP1559_NODE, {}, { gas: 50000n });
    assert.equal(fixed.filled.gas, 50000n);
    assert.ok(!fixed.node.methods().includes("eth_estimateGas"));
  });

  it("multiplies the estimate and caps it below 95% of the block gas limit", async () => {
    const { node, filler: instance } = filler(
      {
        ...EIP1559_NODE,
        eth_getBlockByNumber: () => ({ baseFeePerGas: "0x1", gasLimit: "0x7530" }),
      },
      { gasMultiplier: 1.5 },
    );
    // 21000 * 1.5 = 31500 is above floor(30000 * 0.95) = 28500.
    const capped = await instance.fill("eth_sendTransaction", [{ from: FROM, to: TO }]);
    assert.equal(capped.gas, 28499n);
    const small = await fill(EIP1559_NODE, {}, { gasMultiplier: 1.5 });
    assert.equal(small.filled.gas, 31500n);
    await instance.fill("eth_sendTransaction", [{ from: FROM, to: TO }]);
    // One read for EIP-1559 support, one for the cap; both are kept.
    assert.equal(node.methods().filter((method) => method === "eth_getBlockByNumber").length, 2);
  });

  it("falls back to the default gas limit when an internal call runs out of gas", async () => {
    const pendingLimit = { value: "0x7530" };
    const node = {
      ...EIP1559_NODE,
      eth_estimateGas: () => {
        throw outOfGas();
      },
      eth_getBlockByNumber: (params: unknown[] | undefined) =>
        params?.[0] === "pending"
          ? { gasLimit: pendingLimit.value }
          : { baseFeePerGas: "0x1", gasLimit: "0x1c9c380" },
    };
    const enforced = await fill(node, {}, { fallbackGas: 60000n });
    assert.equal(enforced.filled.gas, 30000n);
    pendingLimit.value = "0x1c9c380";
    const below = await fill(node, {}, { fallbackGas: 60000n });
    assert.equal(below.filled.gas, 60000n);
    const free = await fill(
      node,
      {},
      { fallbackGas: 16_777_216n, isBlockGasLimitEnforced: () => false },
    );
    assert.equal(free.filled.gas, 16_777_216n);
    assert.ok(!free.node.calls.some((call) => call.params?.[0] === "pending"));
  });

  it("recognises the out-of-gas error by class name or by its data, with code -32000", async () => {
    const byReason = await fill(
      throwing(outOfGas({ name: "ProviderError", reason: "InternalCallOutOfGas" })),
      {},
      { fallbackGas: 60000n, isBlockGasLimitEnforced: () => false },
    );
    assert.equal(byReason.filled.gas, 60000n);
    for (const error of [outOfGas({ code: -32603 }), outOfGas({ name: "ProviderError" })]) {
      await assert.rejects(
        fill(throwing(error), {}, { fallbackGas: 60000n }),
        (thrown: unknown) => thrown === error,
      );
    }
    // Without a fallback the error reaches the caller.
    const error = outOfGas();
    await assert.rejects(fill(throwing(error), {}), (thrown: unknown) => thrown === error);
  });

  it("uses the capped block gas limit on an execution error, and rethrows others", async () => {
    const reverted = await fill(
      {
        ...EIP1559_NODE,
        eth_estimateGas: () => {
          throw new Error("Execution error: reverted");
        },
      },
      {},
    );
    // floor(30_000_000 * 0.95)
    assert.equal(reverted.filled.gas, 28_500_000n);
    const other = new Error("insufficient funds");
    await assert.rejects(
      fill(
        {
          ...EIP1559_NODE,
          eth_estimateGas: () => {
            throw other;
          },
        },
        {},
      ),
      (thrown: unknown) => thrown === other,
    );
  });

  it("refuses an estimate or a block gas limit that is not a string", async () => {
    await assertKmsError(
      fill({ ...EIP1559_NODE, eth_estimateGas: () => 21000 }, {}),
      "eth_estimateGas: the node's eth_estimateGas answer is not a string",
    );
    await assertKmsError(
      fill(
        { ...EIP1559_NODE, eth_getBlockByNumber: () => ({ baseFeePerGas: "0x1" }) },
        {},
        { gasMultiplier: 2 },
      ),
      "the latest block has no gasLimit",
    );
  });

  it("keeps a multiplied estimate equal to the cap", async () => {
    // floor(100 * 0.95) = 95, and floor(95 * 1.001) = 95: not above the cap, so kept.
    const { filled } = await fill(
      {
        ...EIP1559_NODE,
        eth_getBlockByNumber: () => ({ baseFeePerGas: "0x1", gasLimit: "0x64" }),
        eth_estimateGas: () => "0x5f",
      },
      {},
      { gasMultiplier: 1.001 },
    );
    assert.equal(filled.gas, 0x5fn);
  });

  it("rounds the capped block gas limit down", async () => {
    // 30_000_001 * 0.95 = 28_500_000.95, floored to 28_500_000; the gas is one below.
    const { filled } = await fill(
      {
        ...EIP1559_NODE,
        eth_getBlockByNumber: () => ({ baseFeePerGas: "0x1", gasLimit: "0x1c9c381" }),
        eth_estimateGas: () => "0x1c9c380",
      },
      {},
      { gasMultiplier: 2 },
    );
    assert.equal(filled.gas, 28_499_999n);
  });
});

describe("HardhatTransactionFiller checks", () => {
  it("reads the pending nonce, or keeps the caller's", async () => {
    const { node, filled } = await fill(EIP1559_NODE, {});
    assert.equal(filled.nonce, 7n);
    assert.deepEqual(node.calls.at(-1), {
      method: "eth_getTransactionCount",
      params: [FROM.toLowerCase(), "pending"],
    });
    const given = await fill(EIP1559_NODE, { nonce: "0x2" });
    assert.equal(given.filled.nonce, 2n);
    assert.ok(!given.node.methods().includes("eth_getTransactionCount"));
    await assertKmsError(
      fill({ ...EIP1559_NODE, eth_getTransactionCount: () => 7 }, {}),
      "eth_sendTransaction: the node's eth_getTransactionCount answer is not a string",
    );
  });

  it("sets the connection's chain id, and refuses another chain", async () => {
    const { filled } = await fill(EIP1559_NODE, {});
    assert.equal(filled.chainId, CHAIN);
    const same = await fill(EIP1559_NODE, { chainId: "0x7a69" });
    assert.equal(same.filled.chainId, CHAIN);
    await assertKmsError(
      fill(EIP1559_NODE, { chainId: "0x1" }),
      "the transaction is for chain 1, but this network is chain 31337",
    );
  });

  it("refuses mixed fee fields and gasPrice with an authorization list", async () => {
    await assertKmsError(
      fill(EIP1559_NODE, { gasPrice: "0x1", maxFeePerGas: "0x1" }),
      "both gasPrice and maxFeePerGas",
    );
    const authorization = {
      chainId: "0x7a69",
      address: TO,
      nonce: "0x0",
      yParity: "0x1",
      r: `0x${"11".repeat(32)}`,
      s: `0x${"22".repeat(32)}`,
    };
    await assertKmsError(
      fill(EIP1559_NODE, { gasPrice: "0x1", authorizationList: [authorization] }),
      "an EIP-7702 transaction (authorizationList) cannot have a gasPrice",
    );
  });

  it("refuses blob transactions before any request", async () => {
    for (const field of ["blobs", "blobVersionedHashes"]) {
      const { node, filler: instance } = filler(EIP1559_NODE);
      await assertKmsError(
        instance.fill("eth_signTransaction", [{ from: FROM, to: TO, [field]: [] }]),
        "eth_signTransaction: blob transactions (EIP-4844) cannot be signed",
      );
      assert.equal(node.calls.length, 0);
    }
  });

  it("refuses a transaction that is not an object, and invalid fields", async () => {
    const { filler: instance } = filler(EIP1559_NODE);
    await assertKmsError(instance.fill("eth_sendTransaction", ["0x"]), "must be an object");
    await assertKmsError(instance.fill("eth_sendTransaction", []), "must be an object");
    await assert.rejects(
      instance.fill("eth_sendTransaction", [{ from: FROM, to: TO, value: "ten" }]),
    );
    // validateParams takes exactly one param, as for Hardhat.
    await assert.rejects(instance.fill("eth_sendTransaction", [{ from: FROM, to: TO }, "latest"]));
  });

  it("does not change the caller's transaction", async () => {
    const tx = { from: FROM, to: TO };
    const { filler: instance } = filler(EIP1559_NODE);
    await instance.fill("eth_sendTransaction", [tx]);
    assert.deepEqual(tx, { from: FROM, to: TO });
  });
});

const hex = (value: string) => new Uint8Array(Buffer.from(value.slice(2), "hex"));

function filledTx(fields: Partial<FilledTransaction>): FilledTransaction {
  return { from: hex(FROM), to: hex(TO), gas: 21000n, nonce: 3n, chainId: CHAIN, ...fields };
}

/** A transaction's raw fields, readable whatever its type. */
function rawOf(tx: UnsignedTransaction): Record<string, unknown> {
  return Object.fromEntries(Object.entries(tx.raw));
}

describe("buildUnsignedTransaction", () => {
  it("builds a legacy transaction with Hardhat's defaults", () => {
    const tx = buildUnsignedTransaction(filledTx({ gasPrice: 5n }));
    assert.equal(tx.type, "legacy");
    assert.equal(tx.isSigned, false);
    assert.deepEqual(
      { ...tx.raw },
      {
        type: "legacy",
        to: addr.addChecksum(TO),
        nonce: 3n,
        chainId: CHAIN,
        value: 0n,
        data: "0x",
        gasLimit: 21000n,
        gasPrice: 5n,
      },
    );
    assert.equal(rawOf(buildUnsignedTransaction(filledTx({}))).gasPrice, 0n);
  });

  it("builds an EIP-2930 transaction from an access list", () => {
    const tx = buildUnsignedTransaction(
      filledTx({
        gasPrice: 5n,
        accessList: [
          { address: hex(TO), storageKeys: [hex(`0x${"01".repeat(32)}`)] },
          { address: hex(FROM), storageKeys: null },
        ],
      }),
    );
    assert.equal(tx.type, "eip2930");
    assert.deepEqual(rawOf(tx).accessList, [
      { address: addr.addChecksum(TO), storageKeys: [`0x${"01".repeat(32)}`] },
      { address: FROM, storageKeys: [] },
    ]);
  });

  it("builds an EIP-1559 transaction", () => {
    const tx = buildUnsignedTransaction(
      filledTx({ maxFeePerGas: 9n, maxPriorityFeePerGas: 1n, value: 4n, data: hex("0xabcd") }),
    );
    assert.equal(tx.type, "eip1559");
    assert.equal(rawOf(tx).maxFeePerGas, 9n);
    assert.equal(rawOf(tx).maxPriorityFeePerGas, 1n);
    assert.deepEqual(rawOf(tx).accessList, []);
    assert.equal(rawOf(tx).value, 4n);
    assert.equal(rawOf(tx).data, "0xabcd");
  });

  it("builds an EIP-7702 transaction from an authorization list", () => {
    const tx = buildUnsignedTransaction(
      filledTx({
        maxFeePerGas: 9n,
        maxPriorityFeePerGas: 1n,
        authorizationList: [
          {
            chainId: CHAIN,
            address: hex(TO),
            nonce: 0n,
            yParity: hex("0x01"),
            r: hex(`0x${"11".repeat(32)}`),
            s: hex(`0x${"22".repeat(32)}`),
          },
        ],
      }),
    );
    assert.equal(tx.type, "eip7702");
    assert.deepEqual(rawOf(tx).authorizationList, [
      {
        chainId: CHAIN,
        address: addr.addChecksum(TO),
        nonce: 0n,
        yParity: 1,
        r: BigInt(`0x${"11".repeat(32)}`),
        s: BigInt(`0x${"22".repeat(32)}`),
      },
    ]);
  });

  it("keeps the access list in EIP-1559 and EIP-7702 transactions", () => {
    const slot = `0x${"01".repeat(32)}`;
    const accessList = [
      { address: hex(TO), storageKeys: [hex(slot)] },
      { address: hex(FROM), storageKeys: null },
    ];
    const expected = [
      { address: addr.addChecksum(TO), storageKeys: [slot] },
      { address: FROM, storageKeys: [] },
    ];
    const fees = { maxFeePerGas: 9n, maxPriorityFeePerGas: 1n, accessList };
    const eip1559 = buildUnsignedTransaction(filledTx(fees));
    assert.equal(eip1559.type, "eip1559");
    assert.deepEqual(rawOf(eip1559).accessList, expected);
    const authorizationList = [
      {
        chainId: CHAIN,
        address: hex(TO),
        nonce: 0n,
        yParity: hex("0x01"),
        r: hex(`0x${"11".repeat(32)}`),
        s: hex(`0x${"22".repeat(32)}`),
      },
    ];
    const eip7702 = buildUnsignedTransaction(filledTx({ ...fees, authorizationList }));
    assert.equal(eip7702.type, "eip7702");
    assert.deepEqual(rawOf(eip7702).accessList, expected);
  });

  it("builds a contract creation, and refuses one without data", () => {
    const creation = buildUnsignedTransaction(
      filledTx({ to: null, data: hex("0x6000"), gasPrice: 1n }),
    );
    assert.equal(rawOf(creation).to, "0x");
    const { to: _to, ...withoutTo } = filledTx({ gasPrice: 1n });
    for (const tx of [withoutTo, filledTx({ to: null, gasPrice: 1n })]) {
      assert.throws(
        () => buildUnsignedTransaction(tx),
        (error: unknown) =>
          error instanceof HardhatPluginError && error.message.includes("contract creation"),
      );
    }
  });

  it("refuses EIP-1559 and EIP-7702 transactions without both fee fields", () => {
    for (const fields of [
      { maxFeePerGas: 1n },
      { authorizationList: [] },
      { authorizationList: [], maxFeePerGas: 1n },
    ]) {
      assert.throws(
        () => buildUnsignedTransaction(filledTx(fields)),
        (error: unknown) =>
          error instanceof HardhatPluginError && error.message.includes("both maxFeePerGas"),
      );
    }
  });
});

describe("signingHash", () => {
  it("is the digest micro-eth-signer signs", () => {
    const tx = buildUnsignedTransaction(filledTx({ maxFeePerGas: 9n, maxPriorityFeePerGas: 1n }));
    const signed = tx.signBy(HARDHAT_ACCOUNT_0.secretKey, false);
    const signature = secp256k1.sign(signingHash(tx), hex(`0x${HARDHAT_ACCOUNT_0.secretKey}`), {
      prehash: false,
      extraEntropy: false,
      format: "compact",
    });
    const r = Buffer.from(signature.subarray(0, 32)).toString("hex");
    assert.equal(BigInt(`0x${r}`), signed.raw.r);
    assert.equal(Transaction.fromHex(signed.toHex()).sender, HARDHAT_ACCOUNT_0.address);
  });
});
