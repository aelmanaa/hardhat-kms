import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { NetworkConnection } from "hardhat/types/network";
import type { JsonRpcRequest, JsonRpcResponse } from "hardhat/types/providers";

import hardhatKms from "../../../src/index.ts";
import { createNetworkHandlers } from "../../../src/internal/hook-handlers/network.ts";
import type { KmsKeyUserConfig } from "../../../src/types.ts";
import { fakeAdapter } from "../../helpers/fake-adapter.ts";
import { fakeTimers } from "../../helpers/fake-timers.ts";
import { COW_ACCOUNT, PERSONAL_SIGN_VECTORS } from "../../helpers/vectors.ts";

const secretKey = new Uint8Array(Buffer.from(COW_ACCOUNT.secretKey, "hex"));

/** Lets pending promise callbacks run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * The handlers under test with fake timers, a runtime that serves one third-party key, and a way
 * to open fake connections to a network with that key.
 */
async function setUp() {
  const keyConfig: unknown = { provider: "myvault" };
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKms],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a third-party provider's key
    kms: { keys: { cow: keyConfig as KmsKeyUserConfig } },
    networks: { remote: { type: "http", url: "http://127.0.0.1:1", kmsAccounts: ["cow"] } },
  });
  const state = { created: 0, closed: 0 };
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async () => {
      state.created++;
      const adapter = fakeAdapter({ secretKey });
      return {
        ...adapter,
        close: async () => {
          state.closed++;
          await Promise.resolve();
        },
      };
    },
  });
  const timers = fakeTimers();
  const handlers = createNetworkHandlers(timers);
  const networkConfig = hre.config.networks.remote;
  assert.ok(networkConfig);

  const open = async (): Promise<NetworkConnection<string>> => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the fields the hook reads
    const connection = { networkName: "remote", networkConfig } as NetworkConnection<string>;
    assert.ok(handlers.newConnection);
    return await handlers.newConnection(hre, async () => await Promise.resolve(connection));
  };
  const close = async (connection: NetworkConnection<string>): Promise<void> => {
    assert.ok(handlers.closeConnection);
    await handlers.closeConnection(hre, connection, async () => {});
  };
  const sign = async (connection: NetworkConnection<string>): Promise<JsonRpcResponse> => {
    assert.ok(handlers.onRequest);
    const vector = PERSONAL_SIGN_VECTORS[0];
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "personal_sign",
      params: [`0x${vector.message}`, COW_ACCOUNT.address],
    };
    return await handlers.onRequest(hre, connection, request, async () => {
      throw new Error("a KMS request reached the network");
    });
  };
  return { timers, state, open, close, sign };
}

describe("network hook handlers", () => {
  it("closes the signers once idle after the last connection closes", async () => {
    const { timers, state, open, close, sign } = await setUp();
    const connection = await open();
    await sign(connection);
    await close(connection);

    assert.equal(timers.pending(), 1);
    timers.fire();
    await settle();
    assert.equal(state.closed, 1);
  });

  it("keeps the signers while another connection is open", async () => {
    const { timers, state, open, close, sign } = await setUp();
    const first = await open();
    const second = await open();
    await sign(first);
    await close(first);

    assert.equal(timers.pending(), 0);
    await sign(second);
    assert.equal(state.created, 1, "the second connection reuses the signer");
    assert.equal(state.closed, 0);
  });

  it("counts a connection closed twice only once", async () => {
    const { timers, state, open, close, sign } = await setUp();
    const first = await open();
    const second = await open();
    await sign(second);
    await close(first);
    await close(first);

    assert.equal(timers.pending(), 0, "the second connection is still open");
    assert.equal(state.closed, 0);
  });
});
