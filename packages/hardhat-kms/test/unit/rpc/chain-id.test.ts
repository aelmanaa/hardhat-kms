import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardhatPluginError } from "hardhat/plugins";

import { ConnectionChain, parseChainId } from "../../../src/internal/rpc/chain-id.ts";

describe("parseChainId", () => {
  it("reads numbers, bigints, hex and decimal strings exactly", () => {
    assert.equal(parseChainId(undefined, "x", "op"), undefined);
    assert.equal(parseChainId(0, "x", "op"), 0n);
    assert.equal(parseChainId(31337, "x", "op"), 31337n);
    assert.equal(parseChainId(2n ** 80n, "x", "op"), 2n ** 80n);
    assert.equal(parseChainId("0x7a69", "x", "op"), 31337n);
    assert.equal(parseChainId("1208925819614629174706176", "x", "op"), 2n ** 80n);
  });

  it("refuses anything it cannot read exactly", () => {
    const values: unknown[] = [
      null,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 2,
      -1n,
      "",
      "0x",
      "1e3",
      " 1",
      "mainnet",
      {},
    ];
    for (const [index, value] of values.entries()) {
      assert.throws(
        () => parseChainId(value, "domain.chainId", "op"),
        (error: unknown) =>
          error instanceof HardhatPluginError &&
          error.message.includes("domain.chainId is not a chain id"),
        `case ${index}`,
      );
    }
  });
});

describe("parseChainId errors", () => {
  it("names the operation and cuts long values", () => {
    assert.throws(
      () => parseChainId("x".repeat(500), "domain.chainId", "eth_signTypedData_v4"),
      (error: unknown) =>
        error instanceof HardhatPluginError &&
        error.message.startsWith("eth_signTypedData_v4: ") &&
        error.message.length < 200,
    );
  });
});

describe("ConnectionChain", () => {
  it("reads the chain id once", async () => {
    let reads = 0;
    const chain = new ConnectionChain(async () => {
      reads++;
      return await Promise.resolve("0x1");
    }, undefined);

    assert.equal(await chain.chainId(), 1n);
    assert.equal(await chain.chainId(), 1n);
    assert.equal(reads, 1);
  });

  it("does not keep a failed read", async () => {
    let reads = 0;
    const chain = new ConnectionChain(async () => {
      reads++;
      if (reads === 1) {
        throw new Error("node unavailable");
      }
      return await Promise.resolve("0x1");
    }, undefined);

    await assert.rejects(chain.chainId(), /node unavailable/);
    assert.equal(await chain.chainId(), 1n);
  });

  it("requires the configured chain id, and an answer from the node", async () => {
    await assert.rejects(
      new ConnectionChain(async () => await Promise.resolve("0x1"), 5).chainId(),
      /the network config sets chainId 5, but the node reports 1/,
    );
    assert.equal(
      await new ConnectionChain(async () => await Promise.resolve("0x5"), 5).chainId(),
      5n,
    );
    // eth_chainId is a hex quantity; anything else from the node is refused.
    for (const response of [undefined, "31337", 31337, "0x"]) {
      await assert.rejects(
        new ConnectionChain(async () => await Promise.resolve(response), undefined).chainId(),
        /not a hex quantity/,
        String(response),
      );
    }
  });
});
