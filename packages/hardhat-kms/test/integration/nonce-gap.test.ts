// Real queued-node recovery with the HTTP high-water policy enabled on the local EDR node.
import assert from "node:assert/strict";
import { it } from "node:test";

import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatPlugin } from "hardhat/types/plugins";

import hardhatKms from "../../src/index.ts";
import { createNetworkHandlers } from "../../src/internal/hook-handlers/network.ts";
import { fakeAdapter } from "../helpers/fake-adapter.ts";
import { vaultKey } from "../helpers/vault-key.ts";
import { COW_ACCOUNT } from "../helpers/vectors.ts";

const COW = COW_ACCOUNT.address;
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const withHighWater: HardhatPlugin = {
  ...hardhatKms,
  hookHandlers: {
    ...hardhatKms.hookHandlers,
    network: async () => ({
      default: async () => createNetworkHandlers(undefined, undefined, true),
    }),
  },
};

/** Opens a funded local KMS account on a node that mines only when asked. */
async function connect(plugin: HardhatPlugin) {
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [plugin],
    kms: { keys: { cow: vaultKey("cow") }, simulatedBalance: 10n ** 18n },
    networks: { local: { type: "edr-simulated", kmsAccounts: ["cow"], mining: { auto: false } } },
  });
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async () =>
      fakeAdapter({ secretKey: new Uint8Array(Buffer.from(COW_ACCOUNT.secretKey, "hex")) }),
  });
  return await hre.network.create({ network: "local" });
}

it("warns about a queued nonce gap and mines the queue after an explicit nonce fills it", async (t) => {
  const warning = t.mock.method(console, "warn", () => undefined);
  const connection = await connect(withHighWater);
  try {
    await connection.provider.request({ method: "evm_setAutomine", params: [false] });
    const account = await connection.kms.getAccount(COW);
    const parameters = {
      address: account.address,
      chainId: 31337,
      client: { transport: { type: "http" } },
    };
    assert.equal(await account.nonceManager.consume(parameters), 0);
    assert.equal(await account.nonceManager.consume(parameters), 1);
    account.nonceManager.reset(parameters);
    await new Promise((resolve) => setImmediate(resolve));
    const tx = { from: COW, to: TO, value: "0x0", gas: "0x5208", gasPrice: "0x3b9aca00" };
    const hash2: unknown = await connection.provider.request({
      method: "eth_sendTransaction",
      params: [tx],
    });
    const raw1 = await account.signTransaction({
      type: "legacy",
      chainId: 31337,
      nonce: 1,
      to: TO,
      value: 0n,
      gas: 21_000n,
      gasPrice: 1_000_000_000n,
    });
    const hash1: unknown = await connection.provider.request({
      method: "eth_sendRawTransaction",
      params: [raw1],
    });
    await connection.provider.request({ method: "evm_mine" });
    for (const hash of [hash1, hash2]) {
      assert.equal(
        await connection.provider.request({ method: "eth_getTransactionReceipt", params: [hash] }),
        null,
      );
    }
    const hash3: unknown = await connection.provider.request({
      method: "eth_sendTransaction",
      params: [tx],
    });
    const third: unknown = await connection.provider.request({
      method: "eth_getTransactionByHash",
      params: [hash3],
    });
    assert.ok(typeof third === "object" && third !== null);
    assert.equal(Reflect.get(third, "nonce"), "0x3", "automatic sends do not fill the gap");
    const gaps = warning.mock.calls
      .map((call) => String(call.arguments[0]))
      .filter((s) => s.includes("gap"));
    assert.equal(gaps.length, 1);
    assert.match(gaps[0] ?? "", /with nonce 0/);
    assert.match(gaps[0] ?? "", /explicit nonce/);
    const hash0: unknown = await connection.provider.request({
      method: "eth_sendTransaction",
      params: [{ ...tx, nonce: "0x0" }],
    });
    await connection.provider.request({ method: "evm_mine" });
    for (const hash of [hash0, hash1, hash2, hash3]) {
      assert.ok(
        await connection.provider.request({ method: "eth_getTransactionReceipt", params: [hash] }),
      );
    }
  } finally {
    await connection.close();
  }
});
