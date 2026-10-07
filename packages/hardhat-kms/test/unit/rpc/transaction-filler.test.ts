import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HardhatError } from "@nomicfoundation/hardhat-errors";
import { HardhatPluginError } from "hardhat/plugins";
import { addr, Transaction } from "micro-eth-signer";

import {
  buildUnsignedTransaction,
  checkFeeFields,
  type FilledTransaction,
  type FillSettings,
  HardhatTransactionFiller,
  requireGas,
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

  it("falls back to a legacy gas price when eth_feeHistory fails twice, for that send only", async () => {
    for (const history of [
      () => {
        throw new Error("upstream request failed");
      },
      () => {
        throw Object.assign(new Error("header not found"), { code: -32000 });
      },
      // A rejection that is not an error object at all.
      async () => await Promise.reject(null),
      () => ({ baseFeePerGas: "0x1", reward: [] }),
      () => null,
      () => ({ baseFeePerGas: ["0x1"], reward: [] }),
    ]) {
      const { node, filler: instance } = filler({ ...EIP1559_NODE, eth_feeHistory: history });
      const first = await instance.fill("eth_sendTransaction", [{ from: FROM, to: TO }]);
      await instance.fill("eth_sendTransaction", [{ from: FROM, to: TO }]);
      assert.equal(first.gasPrice, 100n);
      // Each fill asks once and retries once; nothing is remembered.
      assert.equal(node.methods().filter((method) => method === "eth_feeHistory").length, 4);
    }
  });

  it("retries a failed eth_feeHistory once, and asks again on the next send", async () => {
    for (const failure of [
      () => {
        throw new Error("upstream unavailable");
      },
      // Anvil before 1.8.0 answered with no reward when its fee cache lagged the head (foundry#15128).
      () => ({ baseFeePerGas: ["0x40"], reward: [] }),
    ]) {
      // The answers in order: one failure, a success, two failures, then successes.
      const plan = [false, true, false, false];
      const { node, filler: instance } = filler({
        ...EIP1559_NODE,
        eth_feeHistory: (params) =>
          (plan.shift() ?? true) ? EIP1559_NODE.eth_feeHistory?.(params) : failure(),
      });
      const send = async () => await instance.fill("eth_sendTransaction", [{ from: FROM, to: TO }]);
      const retried = await send();
      assert.equal(retried.maxFeePerGas, 81n);
      assert.equal(retried.maxPriorityFeePerGas, 2n);
      assert.equal(retried.gasPrice, undefined);
      const histories = () => node.methods().filter((method) => method === "eth_feeHistory").length;
      assert.equal(histories(), 2);
      const legacy = await send();
      assert.equal(legacy.gasPrice, 100n);
      assert.equal(legacy.maxFeePerGas, undefined);
      assert.equal(histories(), 4);
      const recovered = await send();
      assert.equal(recovered.maxFeePerGas, 81n);
      assert.equal(recovered.gasPrice, undefined);
      assert.equal(histories(), 5);
    }
  });

  it("remembers a node without eth_feeHistory (-32601) for the connection, as Hardhat does", async () => {
    const { node, filler: instance } = filler({
      ...EIP1559_NODE,
      eth_feeHistory: () => {
        throw Object.assign(
          new Error("the method eth_feeHistory does not exist/is not available"),
          { code: -32601 },
        );
      },
    });
    const first = await instance.fill("eth_sendTransaction", [{ from: FROM, to: TO }]);
    const second = await instance.fill("eth_sendTransaction", [{ from: FROM, to: TO }]);
    assert.equal(first.gasPrice, 100n);
    assert.equal(second.gasPrice, 100n);
    assert.equal(second.maxFeePerGas, undefined);
    assert.equal(node.methods().filter((method) => method === "eth_feeHistory").length, 1);
  });

  it("does not retry a timed-out eth_feeHistory, and asks again on the next send", async () => {
    let reads = 0;
    const { node, filler: instance } = filler({
      ...EIP1559_NODE,
      eth_feeHistory: (params) => {
        reads += 1;
        if (reads === 1) {
          throw new HardhatError(HardhatError.ERRORS.CORE.NETWORK.NETWORK_TIMEOUT);
        }
        return EIP1559_NODE.eth_feeHistory?.(params);
      },
    });
    const timedOut = await instance.fill("eth_sendTransaction", [{ from: FROM, to: TO }]);
    assert.equal(timedOut.gasPrice, 100n);
    assert.equal(node.methods().filter((method) => method === "eth_feeHistory").length, 1);
    const next = await instance.fill("eth_sendTransaction", [{ from: FROM, to: TO }]);
    assert.equal(next.maxFeePerGas, 81n);
    assert.equal(next.gasPrice, undefined);
    // Another Hardhat network error is retried.
    const refused = filler({
      ...EIP1559_NODE,
      eth_feeHistory: () => {
        throw new HardhatError(HardhatError.ERRORS.CORE.NETWORK.CONNECTION_REFUSED, {
          network: "test",
        });
      },
    });
    await refused.filler.fill("eth_sendTransaction", [{ from: FROM, to: TO }]);
    assert.equal(refused.node.methods().filter((method) => method === "eth_feeHistory").length, 2);
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

/** A number as a JSON-RPC quantity. */
const quantity = (value: bigint) => `0x${value.toString(16)}`;
/** A number as 32 bytes. */
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;

/** An EIP-7702 authorization in JSON-RPC form, with the given r and s. */
function authorizationWith(r: string, s: string) {
  return { chainId: "0x7a69", address: TO, nonce: "0x0", yParity: "0x1", r, s };
}

/** Fills an EIP-7702 transaction; returns the signed r and s and the estimate's r and s. */
async function fillSignature(r: string, s: string) {
  const tx = { from: FROM, to: TO, authorizationList: [authorizationWith(r, s)] };
  const { node, filler: instance } = filler(EIP1559_NODE);
  const filled = await instance.fill("eth_sendTransaction", [tx]);
  const [item] = filled.authorizationList ?? [];
  assert.ok(item !== undefined);
  assert.deepEqual(tx.authorizationList, [authorizationWith(r, s)], "the caller's list is kept");
  const estimate = node.calls.find((call) => call.method === "eth_estimateGas");
  const sent: unknown = estimate?.params?.[0];
  assert.ok(typeof sent === "object" && sent !== null && "authorizationList" in sent);
  const list: unknown = sent.authorizationList;
  assert.ok(Array.isArray(list));
  const [estimated]: unknown[] = list;
  assert.ok(typeof estimated === "object" && estimated !== null);
  assert.ok("r" in estimated && "s" in estimated);
  return {
    r: `0x${Buffer.from(item.r).toString("hex")}`,
    s: `0x${Buffer.from(item.s).toString("hex")}`,
    estimated: { r: estimated.r, s: estimated.s },
  };
}

describe("HardhatTransactionFiller authorization signatures", () => {
  // A 31-byte value: as a quantity, viem drops the leading zero byte of a 32-byte r or s.
  const SHORT = `0x${"ab".repeat(31)}`;
  const PADDED = `0x00${"ab".repeat(31)}`;
  const FULL = `0x${"cd".repeat(32)}`;
  const N = secp256k1.Point.CURVE().n;

  it("signs an r with a leading zero byte as 32 bytes, and estimates with the quantity", async () => {
    // Both forms a caller may send: viem's quantity, and 32 bytes.
    for (const r of [SHORT, PADDED]) {
      const filled = await fillSignature(r, FULL);
      assert.equal(filled.r, PADDED);
      assert.equal(filled.s, FULL);
      assert.deepEqual(filled.estimated, { r: SHORT, s: FULL });
    }
  });

  it("signs an s with a leading zero byte as 32 bytes, and estimates with the quantity", async () => {
    for (const s of [SHORT, PADDED]) {
      const filled = await fillSignature(FULL, s);
      assert.equal(filled.r, FULL);
      assert.equal(filled.s, PADDED);
      assert.deepEqual(filled.estimated, { r: FULL, s: SHORT });
    }
  });

  it("handles both, down to a one-digit quantity", async () => {
    const filled = await fillSignature(SHORT, "0x7");
    assert.equal(filled.r, PADDED);
    assert.equal(filled.s, `0x${"00".repeat(31)}07`);
    assert.deepEqual(filled.estimated, { r: SHORT, s: "0x7" });
    const padded = await fillSignature(PADDED, word(7n));
    assert.deepEqual(padded.estimated, { r: SHORT, s: "0x7" });
  });

  it("accepts uppercase hex digits and a 0X prefix", async () => {
    for (const r of [SHORT.toUpperCase(), `0x${"AB".repeat(31)}`, `0X00${"Ab".repeat(31)}`]) {
      const filled = await fillSignature(r, FULL.toUpperCase());
      assert.equal(filled.r, PADDED);
      assert.equal(filled.s, FULL);
      assert.deepEqual(filled.estimated, { r: SHORT, s: FULL });
    }
  });

  it("accepts r and s up to the curve order minus 1", async () => {
    const filled = await fillSignature("0x1", word(N - 1n));
    assert.deepEqual(filled.estimated, { r: "0x1", s: quantity(N - 1n) });
    assert.equal(filled.s, word(N - 1n));
  });

  it("refuses r or s outside [1, n - 1] before any request to the node", async () => {
    const outside = [
      "0x0",
      `0x${"00".repeat(32)}`,
      quantity(N),
      word(N + 1n),
      `0x${"ff".repeat(32)}`,
    ];
    for (const value of outside) {
      for (const [field, item] of [
        ["r", authorizationWith(value, FULL)],
        ["s", authorizationWith(FULL, value)],
      ] as const) {
        const { node, filler: instance } = filler(EIP1559_NODE);
        await assertKmsError(
          instance.fill("eth_sendTransaction", [{ from: FROM, to: TO, authorizationList: [item] }]),
          `eth_sendTransaction: authorizationList[0].${field} must be between 1 and the secp256k1 curve order minus 1`,
        );
        assert.equal(node.calls.length, 0, value);
      }
    }
  });

  it("still refuses a value over 32 bytes, non-hex, or not a quantity", async () => {
    const refused = [
      `0x01${"ab".repeat(32)}`,
      `0x${"ab".repeat(33)}`,
      "0xzz",
      "abab",
      "0x",
      // Leading zeros: neither a quantity nor a 32-byte hash.
      `0x00${"ab".repeat(30)}`,
    ];
    for (const value of refused) {
      for (const item of [authorizationWith(value, FULL), authorizationWith(FULL, value)]) {
        const tx = { from: FROM, to: TO, authorizationList: [item] };
        const { filler: instance } = filler(EIP1559_NODE);
        await assert.rejects(
          instance.fill("eth_sendTransaction", [tx]),
          /Expected a Buffer with the correct length or a valid RPC hash string/,
          value,
        );
      }
    }
  });

  it("leaves other fields and malformed lists to the schema", async () => {
    const { filler: instance } = filler(EIP1559_NODE);
    const shortNonce = { ...authorizationWith(FULL, FULL), nonce: "0x01" };
    for (const authorizationList of [[shortNonce], ["0x"], "0x"]) {
      await assert.rejects(
        instance.fill("eth_sendTransaction", [{ from: FROM, to: TO, authorizationList }]),
      );
    }
  });
});

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

describe("HardhatTransactionFiller requests", () => {
  it("asks for the latest block without transactions, and for the priority fee without params", async () => {
    const { node } = await fill(
      {
        ...EIP1559_NODE,
        eth_feeHistory: () => ({ baseFeePerGas: ["0x8"], reward: [["0x0"]] }),
        eth_maxPriorityFeePerGas: () => "0x5",
      },
      {},
    );
    assert.deepEqual(node.calls[0], { method: "eth_getBlockByNumber", params: ["latest", false] });
    assert.deepEqual(node.calls[2], { method: "eth_maxPriorityFeePerGas", params: [] });
  });

  it("reads the latest and the pending block without transactions", async () => {
    const node = {
      ...EIP1559_NODE,
      eth_estimateGas: () => {
        throw outOfGas();
      },
    };
    const capped = await fill(EIP1559_NODE, {}, { gasMultiplier: 2 });
    assert.deepEqual(
      capped.node.calls.filter((call) => call.method === "eth_getBlockByNumber"),
      [
        { method: "eth_getBlockByNumber", params: ["latest", false] },
        { method: "eth_getBlockByNumber", params: ["latest", false] },
      ],
    );
    const fallback = await fill(node, {}, { fallbackGas: 60000n });
    assert.deepEqual(fallback.node.calls.at(-2), {
      method: "eth_getBlockByNumber",
      params: ["pending", false],
    });
  });
});

/** Fills twice with an eth_feeHistory answer; returns the first fill and the history calls. */
async function fillWithHistory(answer: unknown, more: Record<string, Handler> = {}) {
  const { node, filler: instance } = filler({
    ...EIP1559_NODE,
    ...more,
    eth_feeHistory: () => answer,
  });
  const first = await instance.fill("eth_sendTransaction", [{ from: FROM, to: TO }]);
  await instance.fill("eth_sendTransaction", [{ from: FROM, to: TO }]);
  const histories = node.methods().filter((method) => method === "eth_feeHistory").length;
  return { first, histories, methods: node.methods() };
}

describe("HardhatTransactionFiller eth_feeHistory answers", () => {
  it("counts an answer it cannot read as no eth_feeHistory, for that send only", async () => {
    for (const answer of [
      null,
      "0x1",
      { reward: [["0x2"]] },
      { baseFeePerGas: ["0x8"] },
      { baseFeePerGas: "0x8", reward: [["0x2"]] },
      { baseFeePerGas: ["0x8"], reward: "0x2" },
      // A flat reward list, an empty one, and a reward that is not a hex quantity.
      { baseFeePerGas: ["0x8"], reward: ["0x5"] },
      { baseFeePerGas: ["0x8"], reward: [[]] },
      { baseFeePerGas: ["0x8"], reward: [[2]] },
      { baseFeePerGas: ["0x8"], reward: [["0xzz"]] },
      // No base fee, or one that is not a hex quantity.
      { baseFeePerGas: [], reward: [["0x2"]] },
      { baseFeePerGas: ["0xzz"], reward: [["0x2"]] },
    ]) {
      const { first, histories } = await fillWithHistory(answer);
      assert.equal(first.gasPrice, 100n, JSON.stringify(answer));
      assert.equal(first.maxFeePerGas, undefined, JSON.stringify(answer));
      assert.equal(histories, 4, JSON.stringify(answer));
    }
  });

  it("reads a zero reward, then a base fee it cannot read, as no eth_feeHistory", async () => {
    const { first, histories, methods } = await fillWithHistory(
      { baseFeePerGas: [7], reward: [["0x0"]] },
      { eth_maxPriorityFeePerGas: () => "0x5" },
    );
    assert.equal(first.gasPrice, 100n);
    assert.equal(histories, 4);
    // As in Hardhat, the priority fee is asked for before the base fee is read.
    assert.ok(methods.includes("eth_maxPriorityFeePerGas"));
  });

  it("uses the last base fee and the first reward", async () => {
    const { first } = await fillWithHistory({
      baseFeePerGas: ["0x1", "0x40"],
      reward: [["0x3", "0x9"]],
    });
    assert.equal(first.maxFeePerGas, 81n);
    assert.equal(first.maxPriorityFeePerGas, 3n);
  });

  it("pays 1 wei when eth_maxPriorityFeePerGas fails or answers with no hex quantity", async () => {
    const zero = { baseFeePerGas: ["0x8"], reward: [["0x0"]] };
    for (const suggested of [
      () => {
        throw new Error("method not found");
      },
      () => 5,
      () => "0xzz",
    ]) {
      const { first, histories } = await fillWithHistory(zero, {
        eth_maxPriorityFeePerGas: suggested,
      });
      assert.equal(first.maxPriorityFeePerGas, 1n);
      assert.equal(first.maxFeePerGas, 10n);
      assert.equal(histories, 2, "eth_feeHistory works, so the next fill asks again");
    }
  });
});

describe("HardhatTransactionFiller error messages", () => {
  it("name the RPC method or the step that failed", async () => {
    const { filler: instance } = filler(EIP1559_NODE);
    await assertKmsError(
      instance.fill("eth_signTransaction", ["0x"]),
      "eth_signTransaction: the transaction must be an object",
    );
    await assertKmsError(
      instance.fill("eth_signTransaction", [{ from: FROM, to: TO, data: () => "0x" }]),
      "eth_signTransaction: the transaction must be plain data",
    );
    await assertKmsError(
      instance.fill("eth_signTransaction", [{ from: FROM, to: TO, chainId: "0x1" }]),
      "eth_signTransaction: the transaction is for chain 1, but this network is chain 31337",
    );
    await assertKmsError(
      fill(
        { ...EIP1559_NODE, eth_getBlockByNumber: () => ({ baseFeePerGas: "0x1" }) },
        {},
        { gasMultiplier: 2 },
      ),
      "eth_getBlockByNumber: the latest block has no gasLimit",
    );
  });

  it("does not take an error with code -32000 and another reason for running out of gas", async () => {
    const error = outOfGas({ name: "ProviderError", reason: "SomethingElse" });
    await assert.rejects(
      fill(throwing(error), {}, { fallbackGas: 60000n, isBlockGasLimitEnforced: () => false }),
      (thrown: unknown) => thrown === error,
    );
  });
});

describe("requireGas and checkFeeFields", () => {
  const request = { from: hex(FROM), to: hex(TO) };

  it("refuse a request without gas, and give its gas", () => {
    assert.throws(
      () => requireGas(request, "eth_sendTransaction"),
      (error: unknown) =>
        error instanceof HardhatPluginError &&
        error.message === "eth_sendTransaction: the transaction has no gas limit",
    );
    assert.equal(requireGas({ ...request, gas: 5n }, "eth_sendTransaction"), 5n);
  });

  it("refuse a request without any fee, which fill never builds", () => {
    assert.throws(
      () => checkFeeFields(request, "eth_signTransaction"),
      (error: unknown) =>
        error instanceof HardhatPluginError &&
        error.message ===
          "eth_signTransaction: the transaction has no gasPrice, maxFeePerGas or maxPriorityFeePerGas",
    );
    for (const fees of [{ gasPrice: 1n }, { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }]) {
      checkFeeFields({ ...request, ...fees }, "eth_signTransaction");
    }
  });
});

describe("buildUnsignedTransaction refusals", () => {
  it("name the step in their messages", () => {
    const { to: _to, ...creation } = filledTx({ gasPrice: 1n });
    for (const [tx, message] of [
      [creation, "sign transaction: a contract creation (no `to`) needs `data`"],
      [
        filledTx({ maxFeePerGas: 1n }),
        "sign transaction: an EIP-1559 or EIP-7702 transaction needs both maxFeePerGas fields",
      ],
      [
        filledTx({ maxPriorityFeePerGas: 1n, authorizationList: [] }),
        "sign transaction: an EIP-1559 or EIP-7702 transaction needs both maxFeePerGas fields",
      ],
    ] as const) {
      assert.throws(
        () => buildUnsignedTransaction(tx),
        (error: unknown) => error instanceof HardhatPluginError && error.message === message,
      );
    }
  });
});

/** Fills a transaction with an authorization list that must be refused; returns the message. */
async function refusal(authorizationList: unknown): Promise<string> {
  const { filler: instance } = filler(EIP1559_NODE);
  const error: unknown = await instance
    .fill("eth_sendTransaction", [{ from: FROM, to: TO, authorizationList }])
    .then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
  assert.ok(error instanceof Error, "the fill must fail");
  return error.message;
}

describe("HardhatTransactionFiller malformed authorization lists", () => {
  it("leave an item that is not an object to the schema", async () => {
    assert.match(await refusal([null]), /Expected object, received null/);
  });

  it("leave an r or s that is not a string to the schema, even one that reads as a quantity", async () => {
    // ["0x1"] reads as "0x1" when turned into a string, and BigInt reads it as 1.
    for (const item of [
      { ...authorizationWith(`0x${"cd".repeat(32)}`, `0x${"cd".repeat(32)}`), r: ["0x1"] },
      { ...authorizationWith(`0x${"cd".repeat(32)}`, `0x${"cd".repeat(32)}`), s: ["0x1"] },
    ]) {
      assert.match(
        await refusal([item]),
        /Expected a Buffer with the correct length or a valid RPC hash string/,
      );
    }
  });

  it("leave a value with text before a quantity to the schema", async () => {
    const full = `0x${"cd".repeat(32)}`;
    for (const item of [authorizationWith("zz0x1", full), authorizationWith(full, "zz0x1")]) {
      assert.match(
        await refusal([item]),
        /Expected a Buffer with the correct length or a valid RPC hash string/,
      );
    }
  });
});
