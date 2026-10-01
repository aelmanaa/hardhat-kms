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

/** Signs the EIP-712 example with a replaced domain, for the chain-check tests. */
async function sign(
  provider: { request: (args: { method: string; params: unknown[] }) => Promise<unknown> },
  domain: Record<string, unknown>,
): Promise<unknown> {
  return await provider.request({
    method: "eth_signTypedData_v4",
    params: [COW_ACCOUNT.address, { ...EIP712_MAIL, domain }],
  });
}

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
  options: { allowCrossChainTypedData?: boolean } = {},
) {
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKms],
    kms: { keys, ...options },
    networks: {
      local: { type: "edr-simulated", kmsAccounts: networkKeys },
      // The chain of the EIP-712 specification example.
      mainnetFork: { type: "edr-simulated", chainId: 1, kmsAccounts: networkKeys },
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
    const { provider } = await hre.network.create("mainnetFork");

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

  describe("typed-data chain check", () => {
    const keys = { cow: vaultKey("cow", COW_ACCOUNT.address) };
    const adapters = { cow: () => fakeAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) }) };
    const { chainId: _mailChain, ...domainWithoutChain } = EIP712_MAIL.domain;
    const noChainTypes = {
      ...EIP712_MAIL.types,
      EIP712Domain: (EIP712_MAIL.types.EIP712Domain ?? []).filter(
        (field) => field.name !== "chainId",
      ),
    };

    it("refuses typed data for another chain before any KMS call", async () => {
      const { hre, created } = await runtime(keys, adapters);
      const { provider } = await hre.network.create("local");

      await assertKmsError(sign(provider, EIP712_MAIL.domain), [
        "the typed data is for chain 1, but this network is chain 31337",
        "kms.allowCrossChainTypedData",
      ]);
      assert.equal(created.cow?.calls.signDigest ?? 0, 0);
    });

    it("accepts the connected chain as a number, a bigint-sized decimal or a hex string", async () => {
      const { hre } = await runtime(keys, adapters);
      const { provider } = await hre.network.create("local");

      for (const chainId of [31337, "31337", "0x7a69"]) {
        const signature = await sign(provider, { ...EIP712_MAIL.domain, chainId });
        assert.match(String(signature), /^0x[0-9a-f]{130}$/, String(chainId));
      }
    });

    it("signs typed data without domain.chainId, as MetaMask, Hardhat and Foundry do", async () => {
      const { hre } = await runtime(keys, adapters);
      const { provider } = await hre.network.create("local");

      const signature = await provider.request({
        method: "eth_signTypedData_v4",
        params: [
          COW_ACCOUNT.address,
          { ...EIP712_MAIL, types: noChainTypes, domain: domainWithoutChain },
        ],
      });
      assert.match(String(signature), /^0x[0-9a-f]{130}$/);
    });

    it("checks chain id 0 instead of treating it as absent, and refuses unreadable chain ids", async () => {
      const { hre, created } = await runtime(keys, adapters);
      const { provider } = await hre.network.create("local");

      await assertKmsError(sign(provider, { ...EIP712_MAIL.domain, chainId: 0 }), [
        "the typed data is for chain 0",
      ]);
      // The EIP-712 encoder or the chain check refuses each one, before any KMS call.
      for (const chainId of ["mainnet", "0x", -1, 1.5, "1e3"]) {
        await assert.rejects(
          sign(provider, { ...EIP712_MAIL.domain, chainId }),
          /typed data is invalid|domain\.chainId is not a chain id/,
          String(chainId),
        );
      }
      assert.equal(created.cow?.calls.signDigest ?? 0, 0);
    });

    it("signs typed data for other chains when kms.allowCrossChainTypedData is set", async () => {
      const { hre } = await runtime(keys, adapters, ["cow"], { allowCrossChainTypedData: true });
      const { provider } = await hre.network.create("local");

      assert.equal(await sign(provider, EIP712_MAIL.domain), EIP712_MAIL_SIGNATURE);
    });

    it("signs exactly the typed data it checked, even if the caller changes it meanwhile", async () => {
      const { hre } = await runtime(keys, adapters);
      const { provider } = await hre.network.create("local");

      // The caller changes the domain while the plugin reads eth_chainId. The check passed for
      // 31337; the signature must be for 31337 too, not for the later chain 1.
      const domain: Record<string, unknown> = { ...EIP712_MAIL.domain, chainId: 31337 };
      const signing = sign(provider, domain);
      setImmediate(() => {
        domain.chainId = 1;
      });
      const signature = await signing;
      assert.notEqual(signature, EIP712_MAIL_SIGNATURE, "signed for chain 1");
      assert.equal(signature, await sign(provider, { ...EIP712_MAIL.domain, chainId: 31337 }));
    });

    it("reads a getter once, and refuses typed data that is not plain data", async () => {
      const { hre } = await runtime(keys, adapters);
      const { provider } = await hre.network.create("local");

      let reads = 0;
      const domain = { ...EIP712_MAIL.domain };
      Object.defineProperty(domain, "chainId", {
        enumerable: true,
        get: () => {
          reads++;
          // Chain 1 on every read but the one a naive check would make.
          return reads === 1 ? 31337 : 1;
        },
      });
      const signature = await sign(provider, domain);
      assert.equal(reads, 1);
      assert.equal(signature, await sign(provider, { ...EIP712_MAIL.domain, chainId: 31337 }));

      await assertKmsError(
        sign(provider, { ...EIP712_MAIL.domain, chainId: 31337, salt: () => "0x00" }),
        ["the typed data must be plain data"],
      );
    });

    it("compares large chain ids exactly", async () => {
      const { hre, created } = await runtime(keys, adapters);
      // The node reports 2^53; 2^53 + 1 differs by one, which a float comparison would miss.
      hre.hooks.registerHandlers("network", {
        onRequest: async (context, connection, request, next) =>
          request.method === "eth_chainId"
            ? { jsonrpc: "2.0", id: request.id, result: "0x20000000000000" }
            : await next(context, connection, request),
      });
      // The http network sets no chainId, so only the node's answer counts.
      const { provider } = await hre.network.create("remote");

      await assertKmsError(sign(provider, { ...EIP712_MAIL.domain, chainId: "9007199254740993" }), [
        "the typed data is for chain 9007199254740993, but this network is chain 9007199254740992",
      ]);
      assert.equal(created.cow?.calls.signDigest ?? 0, 0);
      const signature = await sign(provider, {
        ...EIP712_MAIL.domain,
        chainId: "9007199254740992",
      });
      assert.match(String(signature), /^0x[0-9a-f]{130}$/);
    });

    it("reads the chain id once per connection", async () => {
      const { hre } = await runtime(keys, adapters);
      let reads = 0;
      hre.hooks.registerHandlers("network", {
        onRequest: async (context, connection, request, next) => {
          if (request.method === "eth_chainId") {
            reads++;
          }
          return await next(context, connection, request);
        },
      });
      const first = await hre.network.create("local");
      for (let index = 0; index < 3; index++) {
        await sign(first.provider, { ...EIP712_MAIL.domain, chainId: 31337 });
      }
      assert.equal(reads, 1);

      const second = await hre.network.create("local");
      await sign(second.provider, { ...EIP712_MAIL.domain, chainId: 31337 });
      assert.equal(reads, 2, "each connection reads its own chain id");
    });

    it("refuses to sign when the node's chain differs from the network config", async () => {
      const hre = await createHardhatRuntimeEnvironment({
        plugins: [hardhatKms],
        kms: { keys },
        networks: {
          remote: { type: "http", url: "http://127.0.0.1:1", chainId: 5, kmsAccounts: ["cow"] },
        },
      });
      hre.hooks.registerHandlers("kms", {
        createKeyAdapter: async () => fakeAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) }),
      });
      // The node answers eth_chainId with chain 1 although the config says 5.
      hre.hooks.registerHandlers("network", {
        onRequest: async (context, connection, request, next) =>
          request.method === "eth_chainId"
            ? { jsonrpc: "2.0", id: request.id, result: "0x1" }
            : await next(context, connection, request),
      });
      const { provider } = await hre.network.create("remote");

      await assertKmsError(sign(provider, EIP712_MAIL.domain), [
        "the network config sets chainId 5, but the node reports 1",
      ]);
    });
  });

  describe("kms.simulatedBalance", () => {
    const ONE_ETHER = 10n ** 18n;

    async function fundedRuntime(adapter: () => FakeAdapter) {
      const hre = await createHardhatRuntimeEnvironment({
        plugins: [hardhatKms],
        kms: {
          keys: { cow: vaultKey("cow"), pinned: vaultKey("pinned", HARDHAT_ACCOUNT_0.address) },
          simulatedBalance: ONE_ETHER,
        },
        networks: {
          local: { type: "edr-simulated", kmsAccounts: ["cow", "pinned"] },
          remote: { type: "http", url: "http://127.0.0.1:1", kmsAccounts: ["cow"] },
        },
      });
      hre.hooks.registerHandlers("kms", {
        createKeyAdapter: async (context, key, next) =>
          key.name === "cow" ? adapter() : await next(context, key),
      });
      return hre;
    }

    it("funds each KMS account of an edr-simulated network when it connects", async () => {
      const hre = await fundedRuntime(() => fakeAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) }));
      const { provider } = await hre.network.create("local");

      for (const address of [COW_ACCOUNT.address, HARDHAT_ACCOUNT_0.address]) {
        assert.equal(
          await provider.request({ method: "eth_getBalance", params: [address, "latest"] }),
          `0x${ONE_ETHER.toString(16)}`,
          address,
        );
      }
    });

    it("leaves http networks alone", async () => {
      const hre = await fundedRuntime(() => fakeAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) }));

      // An unreachable node: funding would fail the connection.
      const connection = await hre.network.create("remote");
      await connection.close();
    });

    it("fails the connection when an account's address cannot be looked up", async () => {
      const hre = await fundedRuntime(() =>
        fakeAdapter({
          secretKey: hex(COW_ACCOUNT.secretKey),
          throwError: new TypeError("lookup failed"),
        }),
      );

      let closed = 0;
      hre.hooks.registerHandlers("network", {
        closeConnection: async (context, connection, next) => {
          closed++;
          await next(context, connection);
        },
      });

      await assert.rejects(hre.network.create("local"), (error: unknown) => {
        assert.ok(error instanceof HardhatPluginError, String(error));
        assert.match(error.message, /\(TypeError\)/);
        return true;
      });
      assert.equal(closed, 1, "the connection that failed to fund was closed");
    });
  });
});
