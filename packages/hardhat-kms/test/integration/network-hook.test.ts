import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { HardhatPluginError } from "hardhat/plugins";
import type { NetworkHooks } from "hardhat/types/hooks";
import type { HardhatPlugin } from "hardhat/types/plugins";

import hardhatKms from "../../src/index.ts";
import type { KmsKeyUserConfig } from "../../src/types.ts";
import { type FakeAdapter, fakeAdapter } from "../helpers/fake-adapter.ts";
import {
  COW_ACCOUNT,
  EIP712_MAIL,
  EIP712_MAIL_SIGNATURE,
  HARDHAT_ACCOUNT_0,
  PERSONAL_SIGN_VECTORS,
} from "../helpers/vectors.ts";

const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const ACCOUNT_0 = HARDHAT_ACCOUNT_0.address.toLowerCase();

/** A key of a fake third-party provider, which the tests serve through the `kms` hook. */
function vaultKey(name: string, address?: string): KmsKeyUserConfig {
  const key: unknown = { provider: "myvault", name, ...(address === undefined ? {} : { address }) };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a third-party provider's key
  return key as KmsKeyUserConfig;
}

/**
 * A runtime whose `local` (edr-simulated) and `remote` (http, unreachable) networks have the given
 * KMS keys. Each key name maps to a fake adapter; the adapters are recorded for assertions.
 */
async function runtime(
  keys: Record<string, KmsKeyUserConfig>,
  adapters: Record<string, () => FakeAdapter> = {},
  networkKeys: string[] = Object.keys(keys),
) {
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKms],
    kms: { keys },
    networks: {
      local: { type: "edr-simulated", kmsAccounts: networkKeys },
      remote: { type: "http", url: "http://127.0.0.1:1", kmsAccounts: networkKeys },
    },
  });
  const created: Record<string, FakeAdapter> = {};
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async (context, key, next) => {
      const make = adapters[key.name];
      if (make === undefined) {
        return await next(context, key);
      }
      const adapter = make();
      created[key.name] = adapter;
      return adapter;
    },
  });
  return { hre, created };
}

async function assertKmsError(promise: Promise<unknown>, includes: string[]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HardhatPluginError, String(error));
    for (const part of includes) {
      assert.ok(error.message.includes(part), `"${error.message}" should include "${part}"`);
    }
    return true;
  });
}

describe("network hook", () => {
  it("lists the network's own accounts, then the KMS addresses", async () => {
    const { hre } = await runtime(
      { cow: vaultKey("cow") },
      { cow: () => fakeAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) }) },
    );
    const { provider } = await hre.network.create("local");

    const accounts = await provider.request({ method: "eth_accounts" });
    assert.ok(Array.isArray(accounts));
    assert.equal(accounts.length, 21, "20 simulated accounts and one KMS account");
    assert.equal(String(accounts[0]).toLowerCase(), ACCOUNT_0);
    assert.equal(accounts.at(-1), COW_ACCOUNT.address);
    // The simulated network has no eth_requestAccounts; the plugin asks it for eth_accounts.
    assert.deepEqual(await provider.request({ method: "eth_requestAccounts" }), accounts);
  });

  it("lists a pinned address without calling KMS, and lists an account once", async () => {
    let calls: FakeAdapter["calls"] | undefined;
    const { hre } = await runtime(
      { cow: vaultKey("cow", COW_ACCOUNT.address), zero: vaultKey("zero") },
      {
        cow: () => {
          const adapter = fakeAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) });
          calls = adapter.calls;
          return adapter;
        },
        // The simulated network already has this account.
        zero: () => fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) }),
      },
    );
    const { provider } = await hre.network.create("local");

    const accounts = await provider.request({ method: "eth_accounts" });
    assert.ok(Array.isArray(accounts));
    assert.equal(accounts.length, 21);
    assert.equal(accounts.at(-1), COW_ACCOUNT.address);
    assert.equal(calls?.getPublicKey ?? 0, 0, "the pinned key was not looked up");
  });

  it("lists only the KMS addresses when the network's own list fails", async () => {
    const { hre } = await runtime(
      { cow: vaultKey("cow") },
      { cow: () => fakeAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) }) },
    );
    const connection = await hre.network.create("remote");

    assert.deepEqual(await connection.provider.request({ method: "eth_accounts" }), [
      COW_ACCOUNT.address,
    ]);
    await connection.close();
  });

  it("signs personal_sign and eth_sign for a KMS account exactly like Hardhat's local accounts", async () => {
    // Account 0 is also a simulated account: the hook must answer before Hardhat's own handler.
    const { hre, created } = await runtime(
      { zero: vaultKey("zero") },
      { zero: () => fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey), highS: true }) },
    );
    const { provider } = await hre.network.create("local");

    for (const vector of PERSONAL_SIGN_VECTORS) {
      assert.equal(
        await provider.request({
          method: "personal_sign",
          params: [`0x${vector.message}`, HARDHAT_ACCOUNT_0.address],
        }),
        vector.signature,
      );
      assert.equal(
        await provider.request({
          method: "eth_sign",
          params: [ACCOUNT_0, `0x${vector.message}`],
        }),
        vector.signature,
      );
    }
    // Hardhat also accepts the address as 20 bytes.
    assert.equal(
      await provider.request({
        method: "eth_sign",
        params: [Buffer.from(ACCOUNT_0.slice(2), "hex"), `0x${PERSONAL_SIGN_VECTORS[0].message}`],
      }),
      PERSONAL_SIGN_VECTORS[0].signature,
    );
    assert.ok((created.zero?.calls.signDigest ?? 0) >= 5, "KMS signed every request");
  });

  it("signs eth_signTypedData_v4 for a KMS account, from an object or a JSON string", async () => {
    const { hre } = await runtime(
      { cow: vaultKey("cow") },
      { cow: () => fakeAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) }) },
    );
    const { provider } = await hre.network.create("local");

    for (const data of [EIP712_MAIL, JSON.stringify(EIP712_MAIL)]) {
      assert.equal(
        await provider.request({
          method: "eth_signTypedData_v4",
          params: [COW_ACCOUNT.address, data],
        }),
        EIP712_MAIL_SIGNATURE,
      );
    }
  });

  it("passes requests for other addresses, and other methods, through", async () => {
    const { hre, created } = await runtime(
      { cow: vaultKey("cow") },
      { cow: () => fakeAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) }) },
    );
    const { provider } = await hre.network.create("local");
    const vector = PERSONAL_SIGN_VECTORS[0];

    // Account 0 is not a KMS account here: Hardhat's own local account signs it.
    assert.equal(
      await provider.request({
        method: "personal_sign",
        params: [`0x${vector.message}`, HARDHAT_ACCOUNT_0.address],
      }),
      vector.signature,
    );
    assert.equal(await provider.request({ method: "eth_chainId" }), "0x7a69");
    assert.equal(created.cow?.calls.signDigest ?? 0, 0);
  });

  it("requires strict hex data, as Hardhat does, before any KMS call", async () => {
    const { hre, created } = await runtime(
      { cow: vaultKey("cow", COW_ACCOUNT.address) },
      { cow: () => fakeAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) }) },
    );
    const { provider } = await hre.network.create("local");

    for (const data of ["hello", "0xabc", "0xzz"]) {
      await assert.rejects(
        provider.request({ method: "personal_sign", params: [data, COW_ACCOUNT.address] }),
        data,
      );
    }
    assert.equal(created.cow?.calls.signDigest ?? 0, 0);
  });

  it("rejects malformed typed data before any KMS call", async () => {
    const { hre, created } = await runtime(
      { cow: vaultKey("cow", COW_ACCOUNT.address) },
      { cow: () => fakeAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) }) },
    );
    const { provider } = await hre.network.create("local");

    await assertKmsError(
      provider.request({ method: "eth_signTypedData_v4", params: [COW_ACCOUNT.address, "{"] }),
      ["the typed data is not valid JSON"],
    );
    await assertKmsError(
      provider.request({ method: "eth_signTypedData_v4", params: [COW_ACCOUNT.address, 42] }),
      ["the typed data must be an object"],
    );
    await assertKmsError(
      provider.request({
        method: "eth_signTypedData_v4",
        params: [COW_ACCOUNT.address, { ...EIP712_MAIL, primaryType: "Missing" }],
      }),
      ["the typed data is invalid"],
    );
    assert.equal(created.cow?.calls.signDigest ?? 0, 0);
  });

  it("refuses transactions from KMS accounts until they are supported", async () => {
    const { hre } = await runtime(
      { cow: vaultKey("cow", COW_ACCOUNT.address) },
      { cow: () => fakeAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) }) },
    );
    const { provider } = await hre.network.create("local");

    for (const method of ["eth_sendTransaction", "eth_signTransaction"]) {
      await assertKmsError(
        provider.request({ method, params: [{ from: COW_ACCOUNT.address, to: ACCOUNT_0 }] }),
        [`${method} from KMS accounts is not available yet`, "issues/24"],
      );
    }
  });

  it("reports an adapter that fails to open by its error class only", async () => {
    const { hre } = await runtime(
      { cow: vaultKey("cow") },
      {
        cow: () => {
          throw new TypeError("hhkms-secret-detail");
        },
      },
    );
    const { provider } = await hre.network.create("local");

    await assert.rejects(provider.request({ method: "eth_accounts" }), (error: unknown) => {
      assert.ok(error instanceof HardhatPluginError, String(error));
      assert.match(error.message, /creating the adapter failed \(TypeError\)/);
      assert.ok(!error.message.includes("hhkms-secret"), error.message);
      return true;
    });
  });

  it("refuses two keys that are the same account", async () => {
    const { hre } = await runtime(
      { a: vaultKey("a"), b: vaultKey("b") },
      {
        a: () => fakeAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) }),
        b: () => fakeAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) }),
      },
    );
    const { provider } = await hre.network.create("local");

    await assertKmsError(provider.request({ method: "eth_accounts" }), [
      "b and a are the same account",
    ]);
  });

  it("warns once when the default network has KMS accounts", async () => {
    const warn = mock.method(console, "warn", () => {});
    try {
      const hre = await createHardhatRuntimeEnvironment({
        plugins: [hardhatKms],
        kms: { keys: { cow: vaultKey("cow", COW_ACCOUNT.address) } },
        networks: { default: { type: "edr-simulated", kmsAccounts: ["cow"] } },
      });
      await hre.network.create();
      await hre.network.create();

      const messages = warn.mock.calls.map((call) => String(call.arguments[0]));
      assert.equal(messages.filter((message) => message.includes("`default` network")).length, 1);
    } finally {
      warn.mock.restore();
    }
  });

  it("leaves networks without KMS accounts alone", async () => {
    const { hre, created } = await runtime(
      { cow: vaultKey("cow") },
      { cow: () => fakeAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) }) },
      [],
    );
    const { provider } = await hre.network.create("local");

    const accounts = await provider.request({ method: "eth_accounts" });
    assert.ok(Array.isArray(accounts));
    assert.equal(accounts.length, 20);
    assert.equal(created.cow, undefined);
  });

  it("does not keep a failed address lookup: the next request retries", async () => {
    let attempts = 0;
    const { hre } = await runtime(
      { cow: vaultKey("cow") },
      {
        cow: () => {
          const adapter = fakeAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) });
          return {
            ...adapter,
            getPublicKey: async (ctx) => {
              attempts++;
              if (attempts === 1) {
                throw new TypeError("first lookup fails");
              }
              return await (adapter.getPublicKey?.(ctx) ?? Promise.reject(new Error("no key")));
            },
          };
        },
      },
    );
    const { provider } = await hre.network.create("remote");

    await assert.rejects(provider.request({ method: "eth_accounts" }));
    assert.deepEqual(await provider.request({ method: "eth_accounts" }), [COW_ACCOUNT.address]);
  });

  it("does not warn for named networks", async () => {
    const warn = mock.method(console, "warn", () => {});
    try {
      const { hre } = await runtime({ cow: vaultKey("cow", COW_ACCOUNT.address) });
      await hre.network.create("local");
      assert.equal(warn.mock.callCount(), 0);
    } finally {
      warn.mock.restore();
    }
  });

  it("calls the rest of the chain once per account request", async () => {
    // Hardhat runs plugin handlers in reverse order of `plugins`: listed first, this plugin runs
    // after hardhat-kms and sees what it passes downstream.
    const downstream: string[] = [];
    const countingPlugin: HardhatPlugin = {
      id: "count-downstream",
      hookHandlers: {
        network: async () => ({
          default: async (): Promise<Partial<NetworkHooks>> => ({
            onRequest: async (context, connection, request, next) => {
              downstream.push(request.method);
              return await next(context, connection, request);
            },
          }),
        }),
      },
    };
    const hre = await createHardhatRuntimeEnvironment({
      plugins: [countingPlugin, hardhatKms],
      kms: { keys: { cow: vaultKey("cow", COW_ACCOUNT.address) } },
      networks: { local: { type: "edr-simulated", kmsAccounts: ["cow"] } },
    });
    const { provider } = await hre.network.create("local");
    downstream.length = 0;

    await provider.request({ method: "eth_accounts" });
    await provider.request({ method: "eth_requestAccounts" });
    // eth_requestAccounts is asked downstream as eth_accounts, which every node implements.
    assert.deepEqual(downstream, ["eth_accounts", "eth_accounts"]);
  });

  it("shows Hardhat's own error for a configuration variable that is not set", async () => {
    Reflect.deleteProperty(process.env, "HHKMS_TEST_UNSET_KEY_ID");
    const hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKms],
      kms: { keys: { cow: { provider: "aws", keyId: configVariable("HHKMS_TEST_UNSET_KEY_ID") } } },
      networks: { local: { type: "edr-simulated", kmsAccounts: ["cow"] } },
    });
    // Reads the key id as an adapter does, then would build the adapter.
    hre.hooks.registerHandlers("kms", {
      createKeyAdapter: async (_context, key) => {
        assert.ok(key.provider === "aws");
        await key.keyId.get();
        return fakeAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) });
      },
    });
    const { provider } = await hre.network.create("local");

    await assert.rejects(provider.request({ method: "eth_accounts" }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HHKMS_TEST_UNSET_KEY_ID/);
      assert.doesNotMatch(error.message, /creating the adapter failed/);
      return true;
    });
  });

  it("lists an http network's local accounts first, and lets Hardhat sign for them", async () => {
    const hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKms],
      kms: { keys: { cow: vaultKey("cow", COW_ACCOUNT.address) } },
      networks: {
        remote: {
          type: "http",
          url: "http://127.0.0.1:1",
          accounts: [`0x${HARDHAT_ACCOUNT_0.secretKey}`],
          kmsAccounts: ["cow"],
        },
      },
    });
    const { provider } = await hre.network.create("remote");
    const vector = PERSONAL_SIGN_VECTORS[0];

    assert.deepEqual(await provider.request({ method: "eth_accounts" }), [
      HARDHAT_ACCOUNT_0.address.toLowerCase(),
      COW_ACCOUNT.address,
    ]);
    assert.equal(
      await provider.request({
        method: "personal_sign",
        params: [`0x${vector.message}`, HARDHAT_ACCOUNT_0.address],
      }),
      vector.signature,
    );
  });
});
