// The live tests' retry for reads that reach a lagging node. Runs offline, in `pnpm test`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isLaggingBlockError, retryLagging } from "./helpers/retry.ts";

/** An error shaped like viem's, with the node's message in `details` and a cause. */
class FakeRpcError extends Error {
  public readonly details: string;

  public constructor(details: string, cause?: Error) {
    super(`RPC Request failed.\n\nDetails: ${details}`, { cause });
    this.details = details;
  }
}

/** A read that fails with each error in turn, then returns `value`. */
function flaky<T>(errors: Error[], value: T): { read: () => Promise<T>; calls: () => number } {
  let calls = 0;
  return {
    read: async () => {
      calls++;
      const error = errors[calls - 1];
      if (error !== undefined) {
        throw error;
      }
      return await Promise.resolve(value);
    },
    calls: () => calls,
  };
}

describe("live test retry for lagging nodes", () => {
  it("recognizes the nodes' messages, also in details and causes", () => {
    for (const message of [
      "header not found",
      "block not found",
      "Unknown block",
      "block #11823751 not found",
    ]) {
      assert.ok(isLaggingBlockError(new Error(message)), message);
    }
    assert.ok(isLaggingBlockError(new FakeRpcError("header not found")));
    assert.ok(
      isLaggingBlockError(new Error("call failed", { cause: new Error("header not found") })),
    );
    assert.ok(isLaggingBlockError("block not found"));
    assert.ok(!isLaggingBlockError(new Error("execution reverted: not the owner")));
    assert.ok(!isLaggingBlockError(new Error("nonce too low")));
    assert.ok(!isLaggingBlockError(undefined));
  });

  it("retries a lagging read until it succeeds, pausing between attempts", async () => {
    const pauses: number[] = [];
    const lagging = new FakeRpcError("header not found");
    const read = flaky([lagging, lagging, lagging], 3n);
    const value = await retryLagging(read.read, {
      delayMs: 2000,
      sleep: async (ms) => {
        pauses.push(ms);
        await Promise.resolve();
      },
    });
    assert.equal(value, 3n);
    assert.equal(read.calls(), 4);
    assert.deepEqual(pauses, [2000, 2000, 2000]);
  });

  it("throws any other error at once", async () => {
    const reverted = new Error("execution reverted");
    const read = flaky([reverted], 0n);
    await assert.rejects(retryLagging(read.read, { sleep: async () => {} }), reverted);
    assert.equal(read.calls(), 1);
  });

  it("gives up after the last attempt with the lagging error", async () => {
    const lagging = new Error("block not found");
    const read = flaky(
      Array.from({ length: 20 }, () => lagging),
      0n,
    );
    await assert.rejects(retryLagging(read.read, { tries: 10, sleep: async () => {} }), lagging);
    assert.equal(read.calls(), 10);
  });
});
