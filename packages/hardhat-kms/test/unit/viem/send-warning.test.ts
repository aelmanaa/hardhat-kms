// The warning for a library account whose client sends with its own transport. It is printed
// once per process, so this file holds the process's first such send: node --test runs each test
// file in its own process.
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { createKmsNetworkConnection } from "../../../src/internal/viem/account.ts";
import { ADDRESS, CHAIN_ID, setup } from "../../helpers/library-account.ts";

const warning = (type: string): string =>
  `hardhat-kms: a connection.kms.getAccount account sends with a viem "${type}" transport, which does not go through Hardhat. The plugin chose the transaction's nonce and keeps it from its own sends for 60 s, but it does not order or see the broadcast. Send through custom(connection.provider); see https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/library-accounts.md#sending.`;

describe("the transport warning of library accounts", () => {
  it("is printed once per process, for the first consume with a transport that is not custom", async () => {
    const warn = mock.method(console, "warn", () => undefined);
    try {
      const { connection, nonceCalls } = setup();
      const account = await createKmsNetworkConnection(connection).getAccount(ADDRESS);
      const consume = async (client: unknown): Promise<number> =>
        await account.nonceManager.consume({ address: ADDRESS, chainId: CHAIN_ID, client });
      for (const client of [
        { transport: { type: "custom" } },
        {},
        undefined,
        { transport: "http" },
        { transport: { type: 7 } },
      ]) {
        assert.equal(await consume(client), 7);
      }
      await account.nonceManager.get({
        address: ADDRESS,
        chainId: CHAIN_ID,
        client: { transport: { type: "http" } },
      });
      assert.equal(warn.mock.callCount(), 0, "custom, unknown or get: no warning");

      await consume({ transport: { type: "http" } });
      assert.deepEqual(
        warn.mock.calls.map((call) => call.arguments),
        [[warning("http")]],
      );
      await consume({ transport: { type: "webSocket" } });
      const second = await createKmsNetworkConnection(setup().connection).getAccount(ADDRESS);
      await second.nonceManager.consume({
        address: ADDRESS,
        chainId: CHAIN_ID,
        client: { transport: { type: "http" } },
      });
      assert.equal(warn.mock.callCount(), 1, "printed once for every account of the process");
      assert.equal(nonceCalls.filter(([method]) => method === "choose").length, 8);
    } finally {
      warn.mock.restore();
    }
  });
});
