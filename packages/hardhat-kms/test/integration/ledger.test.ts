// hardhat-kms next to @nomicfoundation/hardhat-ledger, in both plugin orders, on an edr-simulated
// network with a KMS key and a Ledger address. Hardhat runs plugins' network hooks in reverse
// order of `plugins`, so each order puts the other plugin first in the request chain.
//
// No Ledger device is used. The Ledger plugin shows "Connecting to Ledger..." through Hardhat's
// `userInterruptions` hook right before it opens the device. The tests record that message and
// throw from it, which ends the Ledger request with its connection error. Without this, a machine
// without a device would retry for up to 30 minutes, and a machine with one would open it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardhatError } from "@nomicfoundation/hardhat-errors";
import hardhatLedger from "@nomicfoundation/hardhat-ledger";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { HardhatPlugin } from "hardhat/types/plugins";
import { type Hex, getAddress, isHex, verifyMessage } from "viem";

import hardhatKms from "../../src/index.ts";
import type { KmsKeyUserConfig } from "../../src/types.ts";
import { type FakeAdapter, fakeAdapter } from "../helpers/fake-adapter.ts";
import { COW_ACCOUNT, PERSONAL_SIGN_VECTORS } from "../helpers/vectors.ts";

const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const ONE_ETHER = 10n ** 18n;
/** EDR's default accounts on an edr-simulated network without `accounts`. */
const LOCAL_ACCOUNTS = 20;
const KMS_ACCOUNT = getAddress(COW_ACCOUNT.address);
/** An address the Ledger plugin is told it owns. No device holds it, and none is needed. */
const LEDGER_ACCOUNT = getAddress("0x000000000000000000000000000000000000bEEF");
const LEDGER_PLUGIN = "hardhat-ledger";
const LEDGER_CONNECTING = "Connecting to Ledger...";
const STOP = "stopped before opening a Ledger device";
const MESSAGE: Hex = `0x${PERSONAL_SIGN_VECTORS[0].message}`;

/** A key of a fake third-party provider, which the tests serve through the `kms` hook. */
function vaultKey(name: string): KmsKeyUserConfig {
  const key: unknown = { provider: "myvault", name };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a third-party provider's key
  return key as KmsKeyUserConfig;
}

/**
 * A runtime with both plugins in the given order. Its `local` network keeps EDR's default
 * accounts, has the KMS key `cow`, funded by `kms.simulatedBalance`, and the Ledger address.
 *
 * @returns The runtime, the fake KMS behind `cow` once created, and the Ledger plugin's messages.
 */
async function runtime(plugins: HardhatPlugin[]) {
  const hre: HardhatRuntimeEnvironment = await createHardhatRuntimeEnvironment({
    plugins,
    kms: { keys: { cow: vaultKey("cow") }, simulatedBalance: ONE_ETHER },
    networks: {
      local: { type: "edr-simulated", kmsAccounts: ["cow"], ledgerAccounts: [LEDGER_ACCOUNT] },
    },
  });
  const kms: { adapter?: FakeAdapter } = {};
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async (context, key, next) => {
      if (key.name !== "cow") {
        return await next(context, key);
      }
      kms.adapter = fakeAdapter({ secretKey: hex(COW_ACCOUNT.secretKey), highS: true });
      return await Promise.resolve(kms.adapter);
    },
  });
  const ledgerMessages: string[] = [];
  hre.hooks.registerHandlers("userInterruptions", {
    displayMessage: async (context, interruptor, message, next) => {
      if (interruptor !== LEDGER_PLUGIN) {
        await next(context, interruptor, message);
        return;
      }
      ledgerMessages.push(message);
      if (message === LEDGER_CONNECTING) {
        throw new Error(STOP);
      }
    },
  });
  return { hre, kms, ledgerMessages };
}

/** The number of KMS signatures made so far. */
const kmsSignatures = (kms: { adapter?: FakeAdapter }): number =>
  kms.adapter?.calls.signDigest ?? 0;

/** Asserts that a request reached the Ledger plugin, which then tried to open the device. */
async function assertReachedLedger(request: Promise<unknown>, ledgerMessages: string[]) {
  await assert.rejects(request, (error: unknown) => {
    assert.ok(
      HardhatError.isHardhatError(
        error,
        HardhatError.ERRORS.HARDHAT_LEDGER.GENERAL.CONNECTION_ERROR,
      ),
      String(error),
    );
    assert.ok(error.message.includes(STOP), error.message);
    return true;
  });
  assert.ok(ledgerMessages.includes(LEDGER_CONNECTING), "the Ledger plugin tried to connect");
}

const ORDERS = [
  // hardhat-ledger's hook runs first and passes the KMS requests on to hardhat-kms.
  { name: "hardhat-kms listed first", plugins: [hardhatKms, hardhatLedger], kmsFirst: true },
  // hardhat-kms's hook runs first and passes the Ledger requests on to hardhat-ledger.
  { name: "hardhat-ledger listed first", plugins: [hardhatLedger, hardhatKms], kmsFirst: false },
];

for (const order of ORDERS) {
  describe(`hardhat-kms with hardhat-ledger, ${order.name}`, { timeout: 60_000 }, () => {
    it("lists EDR's accounts, the KMS account and the Ledger account", async () => {
      const { hre, ledgerMessages } = await runtime(order.plugins);
      const connection = await hre.network.create("local");

      const accounts = await connection.provider.request({ method: "eth_accounts" });
      assert.ok(Array.isArray(accounts));
      const listed = accounts.map((account) => getAddress(String(account)));
      assert.equal(listed.length, LOCAL_ACCOUNTS + 2);
      // Each plugin appends its accounts to the list the rest of the chain returns, so the plugin
      // whose hook runs first lists its account last.
      assert.deepEqual(
        listed.slice(LOCAL_ACCOUNTS),
        order.kmsFirst ? [KMS_ACCOUNT, LEDGER_ACCOUNT] : [LEDGER_ACCOUNT, KMS_ACCOUNT],
      );

      // hardhat-ledger passes eth_requestAccounts on unchanged, and hardhat-kms answers it with
      // eth_accounts. The Ledger account is listed only when hardhat-ledger's hook runs after
      // hardhat-kms's, and so sees that eth_accounts.
      const requested = await connection.provider.request({ method: "eth_requestAccounts" });
      assert.ok(Array.isArray(requested));
      assert.deepEqual(
        requested.map((account) => getAddress(String(account))),
        order.kmsFirst ? listed.filter((account) => account !== LEDGER_ACCOUNT) : listed,
      );
      assert.deepEqual(ledgerMessages, [], "listing accounts does not open the device");
      await connection.close();
    });

    it("answers personal_sign for the KMS account from hardhat-kms", async () => {
      const { hre, kms, ledgerMessages } = await runtime(order.plugins);
      const connection = await hre.network.create("local");

      const signature = await connection.provider.request({
        method: "personal_sign",
        params: [MESSAGE, KMS_ACCOUNT],
      });
      assert.ok(isHex(signature));
      assert.ok(
        await verifyMessage({ address: KMS_ACCOUNT, message: { raw: MESSAGE }, signature }),
        "the signature recovers to the KMS account",
      );
      assert.equal(kmsSignatures(kms), 1);
      assert.deepEqual(ledgerMessages, [], "the Ledger plugin did not try to sign");
      await connection.close();
    });

    it("signs and sends eth_sendTransaction from the KMS account with hardhat-kms", async () => {
      const { hre, kms, ledgerMessages } = await runtime(order.plugins);
      const connection = await hre.network.create("local");

      const hash = await connection.provider.request({
        method: "eth_sendTransaction",
        params: [{ from: KMS_ACCOUNT, to: LEDGER_ACCOUNT, value: "0x1" }],
      });
      const receipt = await connection.provider.request({
        method: "eth_getTransactionReceipt",
        params: [hash],
      });
      assert.ok(typeof receipt === "object" && receipt !== null && "from" in receipt);
      assert.equal(getAddress(String(receipt.from)), KMS_ACCOUNT);
      assert.equal(kmsSignatures(kms), 1, "EDR holds no key for this account; hardhat-kms signed");
      assert.deepEqual(ledgerMessages, [], "the Ledger plugin did not try to sign");
      await connection.close();
    });

    it("passes personal_sign and eth_sendTransaction for the Ledger account to hardhat-ledger", async () => {
      const { hre, kms, ledgerMessages } = await runtime(order.plugins);
      const connection = await hre.network.create("local");

      await assertReachedLedger(
        connection.provider.request({ method: "personal_sign", params: [MESSAGE, LEDGER_ACCOUNT] }),
        ledgerMessages,
      );
      ledgerMessages.length = 0;
      await assertReachedLedger(
        connection.provider.request({
          method: "eth_sendTransaction",
          params: [{ from: LEDGER_ACCOUNT, to: KMS_ACCOUNT, value: "0x1" }],
        }),
        ledgerMessages,
      );
      assert.equal(kmsSignatures(kms), 0, "hardhat-kms signed nothing");
      await connection.close();
    });
  });
}
