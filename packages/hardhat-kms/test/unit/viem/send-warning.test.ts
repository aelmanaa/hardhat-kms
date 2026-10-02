// The warning that a library account's transactions bypass the plugin's send path. It is printed
// once per process, so this file holds the process's first signed transaction: node --test runs
// each test file in its own process.
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { createKmsNetworkConnection } from "../../../src/internal/viem/account.ts";
import { ADDRESS, setup } from "../../helpers/library-account.ts";

const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TRANSACTION = {
  type: "eip1559",
  chainId: 31337,
  nonce: 0,
  gas: 21_000n,
  maxFeePerGas: 2n,
  maxPriorityFeePerGas: 1n,
  to: TO,
  value: 1n,
} as const;
const WARNING =
  "hardhat-kms: a transaction signed by a connection.kms.getAccount account is sent by viem with eth_sendRawTransaction, which bypasses the plugin's nonce tracking and send lock. Send from a KMS account with connection.viem.getWalletClient(address); see https://github.com/aelmanaa/hardhat-kms/issues/186.";

describe("the send warning of library accounts", () => {
  it("is printed once per process, after the first transaction the KMS signs", async () => {
    const warn = mock.method(console, "warn", () => undefined);
    try {
      // The KMS refuses the first transaction's signature (the second signature of the process):
      // nothing is signed, so nothing can be sent, and no warning is printed yet.
      let signs = 0;
      const first = await createKmsNetworkConnection(
        setup({
          adapter: {
            beforeSign: async () => {
              signs++;
              if (signs === 2) {
                throw await Promise.resolve(new Error("the KMS refused"));
              }
            },
          },
        }).connection,
      ).getAccount(ADDRESS);
      await first.signMessage({ message: "not a transaction" });
      await assert.rejects(async () => await first.signTransaction({ ...TRANSACTION, chainId: 1 }));
      assert.equal(warn.mock.callCount(), 0, "no transaction signed yet, so no warning");
      await assert.rejects(async () => await first.signTransaction(TRANSACTION));
      assert.equal(signs, 2, "the KMS was asked, and refused");
      assert.equal(warn.mock.callCount(), 0, "the KMS refused, so no warning");

      await first.signTransaction(TRANSACTION);
      assert.equal(warn.mock.callCount(), 1);
      assert.deepEqual(warn.mock.calls[0]?.arguments, [WARNING]);

      await first.signTransaction({ ...TRANSACTION, nonce: 1 });
      const second = await createKmsNetworkConnection(setup().connection).getAccount(ADDRESS);
      await second.signTransaction({ ...TRANSACTION, nonce: 2 });
      assert.equal(warn.mock.callCount(), 1, "printed once for every account of the process");
    } finally {
      warn.mock.restore();
    }
  });
});
