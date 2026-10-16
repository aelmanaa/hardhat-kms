import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HardhatError } from "@nomicfoundation/hardhat-errors";
import { isObject } from "@nomicfoundation/hardhat-utils/lang";
import { HardhatPluginError } from "hardhat/plugins";
import { addr, Transaction } from "micro-eth-signer";

import {
  buildUnsignedTransaction,
  checkFeeFields,
  describeType,
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

/** A number as a JSON-RPC quantity. */
const quantity = (value: bigint) => `0x${value.toString(16)}`;

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
    // The estimate sees the filled fees, at the pending block.
    assert.deepEqual(node.calls[2]?.params, [
      { from: FROM, to: TO, maxFeePerGas: "0x51", maxPriorityFeePerGas: "0x2" },
      "pending",
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

// Live run 38801021811 (#492): the GCP account had nonce 126 on a node one block behind and 127
// on the chain, and signed a self-sponsored EIP-7702 delegate-and-call with authorization nonce
// 128. On the lagging state the authorization's nonce does not match, so the node skips it and
// estimates a plain call: 20184 gas. With the authorization applied, the call needs 71897.
const LAGGING_NONCE = { latest: 126n, pending: 127n } as const;
const AUTHORIZATION_NONCE = 128n;
const SKIPPED_ESTIMATE = 20184n;
const APPLIED_ESTIMATE = 71897n;
// add(1), as the live suite's LiveCheck takes it.
const ADD_ONE = `0x1003e2d2${"0".repeat(63)}1`;

/** The account's nonce at a block tag on the lagging node; a tag it does not know has none. */
function laggingNonce(tag: unknown): bigint | undefined {
  if (tag === "pending") {
    return LAGGING_NONCE.pending;
  }
  return tag === undefined || tag === "latest" ? LAGGING_NONCE.latest : undefined;
}

/** Whether an estimate request carries an authorization with this nonce. */
function hasAuthorizationNonce(tx: unknown, nonce: bigint): boolean {
  const list: unknown = isObject(tx) ? tx.authorizationList : undefined;
  return (
    Array.isArray(list) &&
    list.some((item: unknown) => isObject(item) && item.nonce === quantity(nonce))
  );
}

/**
 * A node whose `latest` state is one block behind its `pending` state. Its estimate applies a
 * self-sponsored authorization only when the authorization's nonce is the account's nonce at the
 * estimate's block tag plus one, as EIP-7702 does once the transaction has raised the nonce. A
 * request without a block tag gets `latest`, as on a real node.
 */
const LAGGING_NODE: Record<string, Handler> = {
  ...EIP1559_NODE,
  eth_getTransactionCount: (params) => quantity(laggingNonce(params?.[1]) ?? 0n),
  eth_estimateGas: (params) => {
    const nonce = laggingNonce(params?.[1]);
    const applied = nonce !== undefined && hasAuthorizationNonce(params?.[0], nonce + 1n);
    return quantity(applied ? APPLIED_ESTIMATE : SKIPPED_ESTIMATE);
  },
};

/** The lagging run's delegate-and-call: to itself, 1 wei, add(1), authorization nonce 128. */
const DELEGATE_AND_CALL = {
  to: FROM,
  value: "0x1",
  data: ADD_ONE,
  authorizationList: [
    {
      chainId: "0xaa36a7",
      address: TO,
      nonce: quantity(AUTHORIZATION_NONCE),
      yParity: "0x1",
      r: `0x${"cd".repeat(32)}`,
      s: `0x${"1b".repeat(32)}`,
    },
  ],
};

/** The `eth_estimateGas` requests a node received. */
const estimatesOf = (node: ReturnType<typeof fakeNode>) =>
  node.calls.filter((call) => call.method === "eth_estimateGas");

/** A JSON-RPC error as Hardhat's http provider throws it: an Error with the node's code. */
const rpcError = (message: string, code: number): Error =>
  Object.assign(new Error(message), { code });

describe("HardhatTransactionFiller estimates at the pending block (#492)", () => {
  it("covers a self-sponsored authorization when the latest block lags the pending one", async () => {
    const { node, filled } = await fill(LAGGING_NODE, DELEGATE_AND_CALL);
    assert.equal(filled.nonce, LAGGING_NONCE.pending);
    assert.equal(filled.gas, APPLIED_ESTIMATE);
    assert.deepEqual(
      estimatesOf(node).map((call) => call.params?.[1]),
      ["pending"],
    );
    // The stub is faithful: without a block tag it gives the lagging run's estimate.
    assert.equal(
      LAGGING_NODE.eth_estimateGas?.([estimatesOf(node)[0]?.params?.[0]]),
      quantity(SKIPPED_ESTIMATE),
    );
  });

  it("estimates every other type with the pending tag, the same gas when pending equals latest", async () => {
    // A node that ignores the tag: pending and latest are the same state.
    const requests: Record<string, unknown>[] = [
      {},
      { gasPrice: "0x64" },
      { gasPrice: "0x64", accessList: [{ address: TO, storageKeys: [] }] },
      { maxFeePerGas: "0x64", maxPriorityFeePerGas: "0x1" },
      { to: null, data: "0x6000" },
    ];
    for (const request of requests) {
      const { node, filled } = await fill(
        { ...EIP1559_NODE, eth_estimateGas: () => "0x5a3c" },
        request,
      );
      assert.equal(filled.gas, 0x5a3cn);
      const [estimate, ...others] = estimatesOf(node);
      assert.deepEqual(others, []);
      const [tx, tag, ...rest] = estimate?.params ?? [];
      assert.equal(tag, "pending");
      assert.deepEqual(rest, []);
      assert.ok(isObject(tx) && tx.from === FROM);
    }
  });

  it("estimates again without a block tag when the node refuses pending", async () => {
    const rejections = [
      rpcError("invalid argument 1: unsupported block tag", -32602),
      rpcError("Pending block is not available", -32000),
      new Error("pending state is not available"),
      // geth's message is known even when it mentions execution.
      rpcError("pending state is not available for execution", -32000),
      // Other nodes' wording: pending together with tag, block, support or not available.
      rpcError("eth_estimateGas does not support the pending tag", -32000),
      rpcError("unknown pending tag", -32000),
      rpcError("no pending block", -32000),
      rpcError("pending is unsupported", -32000),
      rpcError("pending is not available here", -32000),
    ];
    for (const rejection of rejections) {
      const { node, filled } = await fill(
        {
          ...EIP1559_NODE,
          eth_estimateGas: (params) => {
            if (params?.[1] === "pending") {
              throw rejection;
            }
            return "0x5a3c";
          },
        },
        {},
      );
      assert.equal(filled.gas, 0x5a3cn, rejection.message);
      const [first, second, ...others] = estimatesOf(node);
      assert.deepEqual(others, []);
      assert.equal(first?.params?.length, 2);
      assert.deepEqual(second?.params, [first?.params?.[0]], "the fallback is the request as is");
    }
  });

  it("handles a failure of the fallback estimate as before", async () => {
    const refused = rpcError("invalid params", -32602);
    const reverted = await fill(
      {
        ...EIP1559_NODE,
        eth_estimateGas: (params) => {
          throw params?.[1] === "pending" ? refused : new Error("Execution error: reverted");
        },
      },
      {},
    );
    assert.equal(reverted.filled.gas, 28_500_000n);
    const other = new Error("insufficient funds");
    await assert.rejects(
      fill(
        {
          ...EIP1559_NODE,
          eth_estimateGas: (params) => {
            throw params?.[1] === "pending" ? refused : other;
          },
        },
        {},
      ),
      (thrown: unknown) => thrown === other,
    );
  });

  it("does not estimate again after any other failure of the pending estimate", async () => {
    const failures: unknown[] = [
      rpcError("execution reverted", 3),
      rpcError("gas required exceeds allowance", -32000),
      new HardhatError(HardhatError.ERRORS.CORE.NETWORK.NETWORK_TIMEOUT),
      // Not an Error: only an Error from the node counts as a refusal.
      { code: -32602, message: "pending block is not available" },
      // A revert whose reason mentions pending is a revert, with any code.
      rpcError("execution reverted: withdrawal pending", 3),
      rpcError("execution reverted: pending state is not available", -32000),
      rpcError("Transaction reverted: pending block is not available", -32602),
      // Code 3 is a revert, whatever the message says.
      rpcError("pending block is not available", 3),
      rpcError("execution reverted: pending", 3),
      rpcError("execution reverted: pending withdrawal", -32000),
      // An execution failure that names pending and a block is not a refusal.
      rpcError("execution failed: pending block", -32000),
      // pending without a refusal word, or a refusal word without pending, is not one either.
      rpcError("too many pending transactions", -32000),
      rpcError("block tag not supported", -32000),
    ];
    for (const failure of failures) {
      const { node, filler: instance } = filler({
        ...EIP1559_NODE,
        eth_estimateGas: async () => await Promise.reject(failure),
      });
      await assert.rejects(
        instance.fill("eth_sendTransaction", [{ from: FROM, to: TO }]),
        (thrown: unknown) => thrown === failure,
      );
      assert.equal(estimatesOf(node).length, 1, String(Reflect.get(Object(failure), "message")));
    }
  });

  it("estimates a replacement without a block tag, and a caller's later nonce at pending", async () => {
    // The pending count is 7: nonce 6 replaces a pending transaction; 7 and 8 do not.
    for (const [nonce, params] of [
      ["0x6", 1],
      ["0x7", 2],
      ["0x8", 2],
    ] as const) {
      const { node, filled } = await fill(EIP1559_NODE, { nonce });
      assert.equal(filled.nonce, BigInt(nonce));
      const [estimate, ...others] = estimatesOf(node);
      assert.deepEqual(others, []);
      assert.equal(estimate?.params?.length, params, nonce);
      if (params === 2) {
        assert.equal(estimate?.params?.[1], "pending");
      }
      // The count is read once, before the estimate, for the sender.
      const counts = node.calls.filter((call) => call.method === "eth_getTransactionCount");
      assert.deepEqual(counts, [{ method: "eth_getTransactionCount", params: [FROM, "pending"] }]);
      assert.ok(
        node.methods().indexOf("eth_getTransactionCount") <
          node.methods().indexOf("eth_estimateGas"),
      );
    }
  });

  it("estimates the lagging run's replacement as before (#492)", async () => {
    // Nonce 126 replaces the pending transaction the lagging node counts at pending: its
    // authorization, nonce 127, only matches the state without that transaction.
    const replacement = {
      ...DELEGATE_AND_CALL,
      nonce: quantity(LAGGING_NONCE.latest),
      authorizationList: [{ ...DELEGATE_AND_CALL.authorizationList[0], nonce: quantity(127n) }],
    };
    const { node, filled } = await fill(LAGGING_NODE, replacement);
    assert.equal(filled.gas, APPLIED_ESTIMATE);
    assert.deepEqual(
      estimatesOf(node).map((call) => call.params?.length),
      [1],
    );
  });

  it("reads no pending count for the estimate without a caller's nonce, or with fixed gas", async () => {
    const plain = await fill(EIP1559_NODE, {});
    assert.deepEqual(plain.node.methods().slice(0, 4), [
      "eth_getBlockByNumber",
      "eth_feeHistory",
      "eth_estimateGas",
      "eth_getTransactionCount",
    ]);
    // A nonce that is not a quantity is left to the schema, which refuses it after the estimate.
    const { node, filler: instance } = filler(EIP1559_NODE);
    await assert.rejects(instance.fill("eth_sendTransaction", [{ from: FROM, to: TO, nonce: 6 }]));
    assert.ok(!node.methods().includes("eth_getTransactionCount"));
    assert.equal(estimatesOf(node)[0]?.params?.[1], "pending");
    const fixed = await fill(EIP1559_NODE, { nonce: "0x6" }, { gas: 50000n });
    assert.ok(!fixed.node.methods().includes("eth_getTransactionCount"));
  });

  it("refuses a pending count that is not a string before estimating a caller's nonce", async () => {
    const { node, filler: instance } = filler({
      ...EIP1559_NODE,
      eth_getTransactionCount: () => 7,
    });
    await assertKmsError(
      instance.fill("eth_signTransaction", [{ from: FROM, to: TO, nonce: "0x6" }]),
      "eth_signTransaction: the node's eth_getTransactionCount answer is not a string",
    );
    assert.ok(!node.methods().includes("eth_estimateGas"));
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
    // With a gas, the caller's nonce needs no count: none for the estimate (#492), none to fill.
    const given = await fill(EIP1559_NODE, { nonce: "0x2", gas: "0x5208" });
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
    for (const extra of [
      { blobs: [] },
      { blobVersionedHashes: [] },
      { maxFeePerBlobGas: "0x1" },
      { type: "0x3" },
    ]) {
      const { node, filler: instance } = filler(EIP1559_NODE);
      await assertKmsError(
        instance.fill("eth_signTransaction", [{ from: FROM, to: TO, ...extra }]),
        "eth_signTransaction: blob transactions (EIP-4844) cannot be signed",
      );
      assert.equal(node.calls.length, 0);
    }
  });

  it("refuses type 3 in every spelling, before any request (#484)", async () => {
    for (const type of [
      "0x03",
      "0X3",
      "0x0003",
      " 0x3",
      "0x3 ",
      "0x3\n",
      3,
      3n,
      "3",
      "03",
      "eip4844",
      "EIP4844",
      " eip4844\n",
    ]) {
      for (const method of ["eth_sendTransaction", "eth_signTransaction"]) {
        const { node, filler: instance } = filler(EIP1559_NODE);
        await assertKmsError(
          instance.fill(method, [{ from: FROM, to: TO, type }]),
          `${method}: blob transactions (EIP-4844) cannot be signed`,
        );
        assert.equal(node.calls.length, 0, String(type));
      }
    }
  });

  it("ignores a type that is not a quantity: the fields decide (#484, #496)", async () => {
    for (const type of [
      "0x",
      "x3",
      "0x 3",
      "0x2x",
      "2x",
      "eip4844x",
      "xeip4844",
      "legacy",
      "eip1559",
      "",
      -1,
      -2n,
      2.5,
      Number.NaN,
      true,
      null,
      undefined,
      [3],
      [2],
      ["eip4844"],
    ]) {
      const { node, filled } = await fill(EIP1559_NODE, { type, gasPrice: "0x5" });
      assert.equal(buildUnsignedTransaction(filled).type, "legacy", String(type));
      assert.ok(node.calls.length > 0);
    }
  });

  it("refuses type 3 with fee fields as a blob transaction, not as a mismatch (#496)", async () => {
    for (const extra of [
      { gasPrice: "0x5" },
      { maxFeePerGas: "0x50", maxPriorityFeePerGas: "0x1" },
    ]) {
      const { node, filler: instance } = filler(EIP1559_NODE);
      await assertKmsError(
        instance.fill("eth_sendTransaction", [{ from: FROM, to: TO, type: "0x3", ...extra }]),
        "eth_sendTransaction: blob transactions (EIP-4844) cannot be signed",
      );
      assert.equal(node.calls.length, 0);
    }
  });
  it("reports unavailable EIP-1559 fees for authorizations without legacy fallback (#435)", async () => {
    for (const extra of [{}, { maxFeePerGas: "0x10" }, { maxPriorityFeePerGas: "0x1" }]) {
      const { node, filler: instance } = filler({
        ...EIP1559_NODE,
        eth_feeHistory: () => {
          throw new Error("gateway down");
        },
      });
      await assertKmsError(
        instance.fill("eth_sendTransaction", [
          {
            from: FROM,
            to: TO,
            authorizationList: [authorizationWith(`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`)],
            ...extra,
          },
        ]),
        "eth_sendTransaction: fee history could not be read; EIP-7702 needs EIP-1559 fees",
      );
      assert.equal(node.methods().filter((method) => method === "eth_feeHistory").length, 2);
      assert.ok(!node.methods().includes("eth_gasPrice"));
      assert.ok(!node.methods().includes("eth_estimateGas"));
    }
    const { node } = await fill(EIP1559_NODE, {
      authorizationList: [authorizationWith(`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`)],
      maxFeePerGas: "0x10",
      maxPriorityFeePerGas: "0x1",
    });
    assert.ok(!node.methods().includes("eth_feeHistory"));
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

/** The message of a send whose type disagrees with its fee fields (#496), with its hint (#504). */
const mismatch = (method: string, requested: string, actual: string, hint: string) =>
  `${method}: the transaction asks for type ${requested}, but its fields make it type ${actual}. Nothing was signed. ${hint}`;

/** The message of a send with a `null` field that decides the type (#504). */
const nullField = (field: string) => (method: string) =>
  `${method}: the transaction's ${field} is null; set a value or leave the field out. Nothing was signed.`;

/** The message of a send whose type the plugin does not sign (#496). */
const unsupported = (type: string) => (method: string) =>
  `${method}: transaction type ${type} is not supported; KMS accounts sign types 0x0, 0x1, 0x2 and 0x4. Nothing was signed.`;

describe("describeType", () => {
  it("names a type by its number and name, or by its name alone when it has no number here", () => {
    assert.equal(describeType("legacy"), "0x0 (legacy)");
    assert.equal(describeType("eip7702"), "0x4 (eip7702)");
    assert.equal(describeType("eip4844"), "eip4844");
  });
});

describe("HardhatTransactionFiller requested type (#496)", () => {
  const EIP1559_FEES = { maxFeePerGas: "0x50", maxPriorityFeePerGas: "0x1" };
  const AUTHORIZATIONS = {
    authorizationList: [authorizationWith(`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`)],
  };
  const METHODS = ["eth_sendTransaction", "eth_signTransaction"];

  async function assertRefused(
    tx: Record<string, unknown>,
    message: (method: string) => string,
    settings: Partial<FillSettings> = {},
  ): Promise<void> {
    for (const method of METHODS) {
      const { node, filler: instance } = filler(EIP1559_NODE, settings);
      await assert.rejects(
        instance.fill(method, [{ from: FROM, to: TO, ...tx }]),
        (error: unknown) => {
          assert.ok(error instanceof HardhatPluginError, String(error));
          assert.equal(error.message, message(method));
          return true;
        },
      );
      assert.deepEqual(node.methods(), [], String(tx.type));
    }
  }

  it("refuses a type that disagrees with the caller's fee fields, before any request", async () => {
    const TO_GAS_PRICE =
      "Set gasPrice instead of maxFeePerGas and maxPriorityFeePerGas, or remove type.";
    const TO_EIP1559 =
      "Set maxFeePerGas and maxPriorityFeePerGas instead of gasPrice, or remove type.";
    const NO_AUTHORIZATIONS = "Remove authorizationList, or remove type.";
    const cases: [Record<string, unknown>, string, string, string][] = [
      // The four requests of the issue.
      [{ type: "0x0", ...EIP1559_FEES }, "0x0 (legacy)", "0x2 (eip1559)", TO_GAS_PRICE],
      [{ type: "0x2", gasPrice: "0x5" }, "0x2 (eip1559)", "0x0 (legacy)", TO_EIP1559],
      [
        { type: "0x1", gasPrice: "0x5", ...AUTHORIZATIONS },
        "0x1 (eip2930)",
        "0x4 (eip7702)",
        NO_AUTHORIZATIONS,
      ],
      [
        { type: "0x4", ...EIP1559_FEES },
        "0x4 (eip7702)",
        "0x2 (eip1559)",
        "Add an authorizationList, or remove type.",
      ],
      // Each field that decides the type, on its own.
      [
        { type: "0x0", maxFeePerGas: "0x50" },
        "0x0 (legacy)",
        "0x2 (eip1559)",
        "Set gasPrice instead of maxFeePerGas, or remove type.",
      ],
      [
        { type: "0x0", maxPriorityFeePerGas: "0x1" },
        "0x0 (legacy)",
        "0x2 (eip1559)",
        "Set gasPrice instead of maxPriorityFeePerGas, or remove type.",
      ],
      [
        { type: "0x0", gasPrice: "0x5", accessList: [] },
        "0x0 (legacy)",
        "0x1 (eip2930)",
        "Remove accessList, or remove type.",
      ],
      [
        { type: "0x2", gasPrice: "0x5", accessList: [] },
        "0x2 (eip1559)",
        "0x1 (eip2930)",
        TO_EIP1559,
      ],
      [
        { type: "0x1", ...EIP1559_FEES, accessList: [] },
        "0x1 (eip2930)",
        "0x2 (eip1559)",
        TO_GAS_PRICE,
      ],
      [
        { type: "0x2", ...EIP1559_FEES, ...AUTHORIZATIONS },
        "0x2 (eip1559)",
        "0x4 (eip7702)",
        NO_AUTHORIZATIONS,
      ],
      [
        { type: "0x0", gasPrice: "0x5", ...AUTHORIZATIONS },
        "0x0 (legacy)",
        "0x4 (eip7702)",
        NO_AUTHORIZATIONS,
      ],
      [
        { type: "0x4", gasPrice: "0x5" },
        "0x4 (eip7702)",
        "0x0 (legacy)",
        "Add an authorizationList, set maxFeePerGas and maxPriorityFeePerGas instead of gasPrice, or remove type.",
      ],
      // Fields of both kinds: the hint names only the fields set (#504).
      [
        { type: "0x0", gasPrice: "0x5", maxFeePerGas: "0x50" },
        "0x0 (legacy)",
        "0x2 (eip1559)",
        "Remove maxFeePerGas, or remove type.",
      ],
      [
        { type: "0x1", gasPrice: "0x5", maxPriorityFeePerGas: "0x1", accessList: [] },
        "0x1 (eip2930)",
        "0x2 (eip1559)",
        "Remove maxPriorityFeePerGas, or remove type.",
      ],
      [
        { type: "0x0", maxFeePerGas: "0x50", accessList: [], ...AUTHORIZATIONS },
        "0x0 (legacy)",
        "0x4 (eip7702)",
        "Set gasPrice instead of maxFeePerGas, remove accessList, remove authorizationList, or remove type.",
      ],
      [
        { type: "0x1", maxFeePerGas: "0x50", accessList: [], ...AUTHORIZATIONS },
        "0x1 (eip2930)",
        "0x4 (eip7702)",
        "Set gasPrice instead of maxFeePerGas, remove authorizationList, or remove type.",
      ],
      [
        { type: "0x2", gasPrice: "0x5", maxFeePerGas: "0x50", ...AUTHORIZATIONS },
        "0x2 (eip1559)",
        "0x4 (eip7702)",
        "Remove gasPrice, remove authorizationList, or remove type.",
      ],
      [
        { type: "0x4", gasPrice: "0x5", maxFeePerGas: "0x50", accessList: [] },
        "0x4 (eip7702)",
        "0x2 (eip1559)",
        "Add an authorizationList, remove gasPrice, or remove type.",
      ],
      // The other forms of the type.
      [{ type: 0, ...EIP1559_FEES }, "0x0 (legacy)", "0x2 (eip1559)", TO_GAS_PRICE],
      [{ type: 0n, ...EIP1559_FEES }, "0x0 (legacy)", "0x2 (eip1559)", TO_GAS_PRICE],
      [{ type: 2n, gasPrice: "0x5" }, "0x2 (eip1559)", "0x0 (legacy)", TO_EIP1559],
      [{ type: " 0X02 ", gasPrice: "0x5" }, "0x2 (eip1559)", "0x0 (legacy)", TO_EIP1559],
      [{ type: "0x00", ...EIP1559_FEES }, "0x0 (legacy)", "0x2 (eip1559)", TO_GAS_PRICE],
      [
        { type: "1", maxFeePerGas: "0x50" },
        "0x1 (eip2930)",
        "0x2 (eip1559)",
        "Set gasPrice instead of maxFeePerGas, or remove type.",
      ],
    ];
    for (const [tx, requested, actual, hint] of cases) {
      await assertRefused(tx, (method) => mismatch(method, requested, actual, hint));
    }
  });

  it("signs a type that agrees with the fields, in every form", async () => {
    const cases: [string, Record<string, unknown>, unknown[]][] = [
      ["legacy", { gasPrice: "0x5" }, ["0x0", "0x00", "0X0", " 0x0\n", 0, 0n, "0"]],
      ["eip2930", { gasPrice: "0x5", accessList: [] }, ["0x1", "0x01", 1, 1n, "1"]],
      ["eip1559", EIP1559_FEES, ["0x2", "0x002", 2, 2n, "2"]],
      ["eip1559", { maxPriorityFeePerGas: "0x1" }, ["0x2", 2]],
      ["eip1559", { maxFeePerGas: "0x50", accessList: [] }, ["0x2", 2n]],
      ["eip7702", { ...EIP1559_FEES, ...AUTHORIZATIONS }, ["0x4", "0x04", 4, 4n, "4"]],
    ];
    for (const [expected, fields, types] of cases) {
      for (const type of types) {
        const { filled } = await fill(EIP1559_NODE, { type, ...fields });
        assert.equal(buildUnsignedTransaction(filled).type, expected, String(type));
      }
    }
  });

  it("signs type 1 with a gasPrice and no access list as EIP-2930 with an empty list", async () => {
    for (const type of ["0x1", 1, 1n, "1"]) {
      const tx = { from: FROM, to: TO, type, gasPrice: "0x5" };
      const { node, filler: instance } = filler(EIP1559_NODE);
      const filled = await instance.fill("eth_signTransaction", [tx]);
      const unsigned = buildUnsignedTransaction(filled);
      assert.equal(unsigned.type, "eip2930", String(type));
      assert.deepEqual(filled.accessList, []);
      assert.equal(filled.gasPrice, 5n);
      assert.equal("accessList" in tx, false, "the caller's transaction is kept");
      const estimate = node.calls.find((call) => call.method === "eth_estimateGas");
      const sent: unknown = estimate?.params?.[0];
      assert.ok(isObject(sent));
      assert.deepEqual(sent.accessList, [], "the estimate is of the transaction signed");
    }
  });

  it("refuses a null fee or list field with an error that names it, before any request", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ type: "0x0", gasPrice: "0x5", maxFeePerGas: null }, "maxFeePerGas"],
      [
        { type: "0x2", maxFeePerGas: "0x50", accessList: null, authorizationList: null },
        "accessList",
      ],
      [{ type: "0x1", gasPrice: "0x5", accessList: null }, "accessList"],
      [{ type: "0x2", gasPrice: null, maxFeePerGas: "0x50" }, "gasPrice"],
      [{ type: "0x0", gasPrice: "0x5", maxPriorityFeePerGas: null }, "maxPriorityFeePerGas"],
      [{ type: "0x0", gasPrice: "0x5", authorizationList: null }, "authorizationList"],
      // Without a type, with no other fee field, and with a type that is not a number.
      [{ gasPrice: null }, "gasPrice"],
      [{ maxFeePerGas: null, maxPriorityFeePerGas: "0x1" }, "maxFeePerGas"],
      [{ maxFeePerGas: null, maxPriorityFeePerGas: null }, "maxFeePerGas"],
      [{ gasPrice: "0x5", maxPriorityFeePerGas: null }, "maxPriorityFeePerGas"],
      [{ maxFeePerGas: "0x50", maxPriorityFeePerGas: null }, "maxPriorityFeePerGas"],
      [{ accessList: null }, "accessList"],
      [{ authorizationList: null }, "authorizationList"],
      [{ type: "0x2", authorizationList: null }, "authorizationList"],
      [{ type: "legacy", gasPrice: null }, "gasPrice"],
    ];
    for (const [tx, field] of cases) {
      await assertRefused(tx, nullField(field));
    }
  });

  it("refuses a lone null EIP-1559 fee field when the gasPrice setting is fixed, as the schema did", async () => {
    for (const [tx, field] of [
      [{ maxFeePerGas: null }, "maxFeePerGas"],
      [{ type: "0x2", maxPriorityFeePerGas: null }, "maxPriorityFeePerGas"],
    ] as const) {
      await assertRefused(tx, nullField(field), { gasPrice: 7n });
    }
  });

  it("fills a lone null EIP-1559 fee field with automatic fees, like an absent one, as before", async () => {
    const { filled: absent } = await fill(EIP1559_NODE, {});
    const cases: [Record<string, unknown>, string][] = [
      [{ maxFeePerGas: null }, "eip1559"],
      [{ maxPriorityFeePerGas: null }, "eip1559"],
      [{ type: "0x2", maxFeePerGas: null }, "eip1559"],
      [{ type: "eip1559", maxPriorityFeePerGas: null }, "eip1559"],
      [{ type: "legacy", maxFeePerGas: null }, "eip1559"],
      [{ type: "0x4", maxFeePerGas: null, ...AUTHORIZATIONS }, "eip7702"],
      [{ maxPriorityFeePerGas: null, ...AUTHORIZATIONS }, "eip7702"],
    ];
    for (const [extra, expected] of cases) {
      const { filled } = await fill(EIP1559_NODE, extra);
      const label = JSON.stringify(extra);
      assert.equal(filled.maxFeePerGas, absent.maxFeePerGas, label);
      assert.equal(filled.maxPriorityFeePerGas, absent.maxPriorityFeePerGas, label);
      assert.equal(buildUnsignedTransaction(filled).type, expected, label);
    }
  });

  it("refuses a lone null EIP-1559 fee field with a type the fill contradicts", async () => {
    await assertRefused({ type: "0x0", maxFeePerGas: null }, (method) =>
      mismatch(
        method,
        "0x0 (legacy)",
        "0x2 (eip1559)",
        "Set gasPrice instead of maxFeePerGas, or remove type.",
      ),
    );
    await assertRefused({ type: "0x1", maxPriorityFeePerGas: null }, (method) =>
      mismatch(
        method,
        "0x1 (eip2930)",
        "0x2 (eip1559)",
        "Set gasPrice instead of maxPriorityFeePerGas, or remove type.",
      ),
    );
    await assertRefused({ type: "0x2", maxFeePerGas: null, ...AUTHORIZATIONS }, (method) =>
      mismatch(
        method,
        "0x2 (eip1559)",
        "0x4 (eip7702)",
        "Remove authorizationList, or remove type.",
      ),
    );
  });

  it("refuses an unsupported type before a null field", async () => {
    await assertRefused({ type: "0x7e", gasPrice: null }, unsupported("0x7e"));
  });

  it("lets the filled fees decide when the caller set none, as today", async () => {
    for (const extra of [
      { type: "0x0" },
      { type: "0x2" },
      { type: 0 },
      { type: "0x1", accessList: [] },
      { type: "0x0", accessList: [] },
      { type: "0x0", ...AUTHORIZATIONS },
    ]) {
      const { filled } = await fill(EIP1559_NODE, extra);
      assert.notEqual(filled.maxFeePerGas, undefined, JSON.stringify(extra));
      assert.equal(filled.gasPrice, undefined);
    }
    const { filled } = await fill(EIP1559_NODE, { type: "0x2" }, { gasPrice: 7n });
    assert.equal(buildUnsignedTransaction(filled).type, "legacy");
  });

  it("refuses a type it does not sign, with or without fee fields, before any request", async () => {
    for (const [type, shown] of [
      ["0x5", "0x5"],
      ["0x05", "0x5"],
      [5, "0x5"],
      [5n, "0x5"],
      ["5", "0x5"],
      ["0x7e", "0x7e"],
      ["0x7E", "0x7e"],
      [126, "0x7e"],
      ["0x10000000000000000", "0x10000000000000000"],
      [2n ** 64n, "0x10000000000000000"],
    ] as const) {
      for (const extra of [{}, { gasPrice: "0x5" }, EIP1559_FEES]) {
        await assertRefused({ type, ...extra }, unsupported(shown));
      }
    }
  });
});

const hex = (value: string) => new Uint8Array(Buffer.from(value.slice(2), "hex"));

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
