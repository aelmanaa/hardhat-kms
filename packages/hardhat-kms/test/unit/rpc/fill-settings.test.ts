// fillSettings and createTransactionFiller on an http connection that never reaches a node: the
// provider's fields and its request function are set by each test.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { NetworkConnection } from "hardhat/types/network";
import type { RequestArguments } from "hardhat/types/providers";

import { ConnectionChain } from "../../../src/internal/rpc/chain-id.ts";
import {
  createTransactionFiller,
  fillSettings,
} from "../../../src/internal/rpc/transaction-filler.ts";

const FROM = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const TO = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

/** A new connection to an http network that no node answers. */
async function connect(): Promise<NetworkConnection<string>> {
  const hre = await createHardhatRuntimeEnvironment({
    networks: { remote: { type: "http", url: "http://127.0.0.1:1", gasMultiplier: 1.5 } },
  });
  return await hre.network.create("remote");
}

/** The connection with fields added to its provider. */
async function withProvider(fields: Record<string, unknown>): Promise<NetworkConnection<string>> {
  const connection = await connect();
  return { ...connection, provider: Object.assign(connection.provider, fields) };
}

describe("fillSettings", () => {
  it("reads the network's gas settings", async () => {
    const settings = fillSettings(await connect());
    assert.equal(settings.gas, "auto");
    assert.equal(settings.gasPrice, "auto");
    assert.equal(settings.gasMultiplier, 1.5);
  });

  it("takes a provider's default gas limit only when it is a bigint", async () => {
    assert.equal(fillSettings(await connect()).fallbackGas, undefined);
    const bigint = await withProvider({ defaultTransactionGasLimit: 30_000_000n });
    assert.equal(fillSettings(bigint).fallbackGas, 30_000_000n);
    const number = await withProvider({ defaultTransactionGasLimit: 30_000_000 });
    assert.equal(fillSettings(number).fallbackGas, undefined);
  });

  it("counts the block gas limit as enforced unless the provider says false", async () => {
    assert.equal(fillSettings(await connect()).isBlockGasLimitEnforced(), true);
    for (const [value, enforced] of [
      [true, true],
      [false, false],
      [undefined, true],
    ] as const) {
      const connection = await withProvider({ isBlockGasLimitEnforced: value });
      assert.equal(fillSettings(connection).isBlockGasLimitEnforced(), enforced, String(value));
    }
  });

  it("reads the enforcement on each use", async () => {
    const connection = await withProvider({ isBlockGasLimitEnforced: true });
    const settings = fillSettings(connection);
    Object.assign(connection.provider, { isBlockGasLimitEnforced: false });
    assert.equal(settings.isBlockGasLimitEnforced(), false);
  });
});

describe("createTransactionFiller", () => {
  it("sends its requests through the provider, with params only when it has some", async () => {
    const requests: RequestArguments[] = [];
    const answers: Record<string, unknown> = {
      eth_getBlockByNumber: { gasLimit: "0x1c9c380" },
      eth_gasPrice: "0x64",
      eth_estimateGas: "0x5208",
      eth_getTransactionCount: "0x7",
    };
    const connection = await withProvider({
      request: async (request: RequestArguments) => {
        requests.push(request);
        return await Promise.resolve(answers[request.method]);
      },
    });
    const chain = new ConnectionChain(async () => await Promise.resolve("0x2a"), undefined);
    const filled = await createTransactionFiller(connection, chain).fill("eth_sendTransaction", [
      { from: FROM, to: TO },
    ]);
    assert.equal(filled.chainId, 42n);
    assert.equal(filled.gasPrice, 100n);
    assert.equal(filled.nonce, 7n);
    assert.deepEqual(
      requests.map((request) => request.method),
      [
        "eth_getBlockByNumber",
        "eth_gasPrice",
        "eth_estimateGas",
        "eth_getBlockByNumber",
        "eth_getTransactionCount",
      ],
    );
    assert.deepEqual(requests[1], { method: "eth_gasPrice" });
    assert.deepEqual(requests[0], { method: "eth_getBlockByNumber", params: ["latest", false] });
  });
});
