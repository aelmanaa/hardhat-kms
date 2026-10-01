// Transactions from KMS accounts. The raw bytes must equal those Hardhat's local accounts sign for
// the same request on the same chain state, and sending must work end to end.
import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { HardhatPluginError } from "hardhat/plugins";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import { authorization, Transaction } from "micro-eth-signer";
import { getAddress } from "viem";

import hardhatKms from "../../src/index.ts";
import type { KmsKeyUserConfig } from "../../src/types.ts";
import { type FakeAdapter, type FakeAdapterOptions, fakeAdapter } from "../helpers/fake-adapter.ts";
import { type RecordingNode, startRecordingNode } from "../helpers/recording-node.ts";
import { COW_ACCOUNT, HARDHAT_ACCOUNT_0 } from "../helpers/vectors.ts";

const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const FROM = HARDHAT_ACCOUNT_0.address;
/** Hardhat's second default account, used as a local account and as a recipient. */
const ACCOUNT_1 = {
  secretKey: "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
};
const TO = ACCOUNT_1.address;
/** An address that is neither a KMS account nor one of the node's accounts. */
const STRANGER = "0x000000000000000000000000000000000000dEaD";
// Creation code that deploys a contract returning 42.
const INIT_CODE = "0x600a600c600039600a6000f3602a60005260206000f3";
const CURVE_ORDER = secp256k1.Point.CURVE().n;

/** A key of a fake third-party provider, which the tests serve through the `kms` hook. */
function vaultKey(name: string): KmsKeyUserConfig {
  const key: unknown = { provider: "myvault", name };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a third-party provider's key
  return key as KmsKeyUserConfig;
}

/** An EIP-7702 authorization in the shape of a JSON-RPC request. */
function rpcAuthorization(item: { yParity: number; r: bigint; s: bigint }) {
  return {
    chainId: "0x7a69",
    address: TO,
    nonce: "0x1",
    yParity: `0x${item.yParity.toString(16)}`,
    r: `0x${item.r.toString(16).padStart(64, "0")}`,
    s: `0x${item.s.toString(16).padStart(64, "0")}`,
  };
}

const AUTHORIZATION = authorization.sign(
  { chainId: 31337n, address: TO, nonce: 1n },
  `0x${HARDHAT_ACCOUNT_0.secretKey}`,
);

/** The fake adapter behind each key name. */
const ADAPTERS: Record<string, Partial<FakeAdapterOptions> & { secretKey: Uint8Array }> = {
  zero: { secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) },
  zeroHighS: { secretKey: hex(HARDHAT_ACCOUNT_0.secretKey), highS: true, format: "compact" },
  wrongKey: {
    secretKey: hex(HARDHAT_ACCOUNT_0.secretKey),
    signWithSecretKey: hex(COW_ACCOUNT.secretKey),
  },
  cow: { secretKey: hex(COW_ACCOUNT.secretKey) },
};

/** Serves the fake adapters through the `kms` hook, and records each one. */
function serveAdapters(hre: HardhatRuntimeEnvironment): Record<string, FakeAdapter> {
  const created: Record<string, FakeAdapter> = {};
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async (context, key, next) => {
      const options = ADAPTERS[key.name];
      if (options === undefined) {
        return await next(context, key);
      }
      const adapter = fakeAdapter(options);
      created[key.name] = adapter;
      return adapter;
    },
  });
  return created;
}

/** The address a raw transaction recovers to. */
function senderOf(raw: string): string {
  return Transaction.fromHex(raw, false).sender;
}

/** A transaction's receipt, as a record. */
async function receiptOf(
  provider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> },
  hash: unknown,
): Promise<Record<string, unknown>> {
  const receipt = await provider.request({
    method: "eth_getTransactionReceipt",
    params: [hash],
  });
  assert.ok(typeof receipt === "object" && receipt !== null);
  return Object.fromEntries(Object.entries(receipt));
}

describe("signing transactions for KMS accounts", () => {
  let node: RecordingNode;
  let hre: HardhatRuntimeEnvironment;
  let created: Record<string, FakeAdapter>;

  before(async () => {
    node = await startRecordingNode();
    const on = { type: "http" as const, url: node.url, chainId: 31337 };
    hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKms],
      kms: {
        keys: Object.fromEntries(Object.keys(ADAPTERS).map((name) => [name, vaultKey(name)])),
      },
      networks: {
        hardhat: { ...on, accounts: [`0x${HARDHAT_ACCOUNT_0.secretKey}`] },
        kms: { ...on, kmsAccounts: ["zero"] },
        kmsHighS: { ...on, kmsAccounts: ["zeroHighS"] },
        kmsWrongKey: { ...on, kmsAccounts: ["wrongKey"] },
        kmsFrom: { ...on, kmsAccounts: ["cow", "zero"], from: FROM },
        kmsAutomatic: { ...on, kmsAccounts: ["cow", "zero"] },
        otherFrom: { ...on, kmsAccounts: ["cow"], from: STRANGER },
        kmsCow: { ...on, kmsAccounts: ["cow"] },
        localFirst: { ...on, accounts: [`0x${ACCOUNT_1.secretKey}`], kmsAccounts: ["zero"] },
      },
    });
    created = serveAdapters(hre);
  });

  after(async () => {
    await node.server.close();
  });

  /**
   * Sends one request on a fresh connection to a network. For `eth_sendTransaction` it returns
   * the raw transaction the node received; for `eth_signTransaction`, the result, after checking
   * that nothing was broadcast.
   */
  async function rawOf(
    network: string,
    request: Record<string, unknown>,
    method = "eth_sendTransaction",
  ): Promise<string> {
    const connection = await hre.network.create(network);
    try {
      const sent = node.raw.length;
      const result = await connection.provider.request({
        method,
        params: [structuredClone(request)],
      });
      if (method === "eth_signTransaction") {
        assert.equal(node.raw.length, sent, "eth_signTransaction broadcast nothing");
        assert.ok(typeof result === "string");
        return result;
      }
      assert.equal(node.raw.length, sent + 1, "one raw transaction was broadcast");
      const raw = node.raw[sent] ?? "";
      assert.equal(result, `0x${Buffer.from(keccak_256(hex(raw.slice(2)))).toString("hex")}`);
      return raw;
    } finally {
      await connection.close();
    }
  }

  /** Sends a transaction with one authorization, and returns the warnings it printed. */
  async function warningsFor(item: { yParity: number; r: bigint; s: bigint }) {
    const warn = mock.method(console, "warn", () => {});
    try {
      const raw = await rawOf("kms", {
        from: FROM,
        to: FROM,
        authorizationList: [rpcAuthorization(item)],
      });
      assert.equal(senderOf(raw), FROM, "the transaction is still signed and sent");
      return warn.mock.calls.map((call) => String(call.arguments[0]));
    } finally {
      warn.mock.restore();
    }
  }

  const CASES: [string, Record<string, unknown>][] = [
    ["legacy", { from: FROM, to: TO, value: "0x1", gasPrice: "0x3b9aca00" }],
    [
      "eip2930",
      {
        from: FROM,
        to: TO,
        gasPrice: "0x3b9aca00",
        accessList: [{ address: TO, storageKeys: [`0x${"00".repeat(31)}01`] }],
      },
    ],
    ["eip1559", { from: FROM, to: TO, value: "0x1" }],
    ["eip1559", { from: FROM, data: INIT_CODE }],
    ["eip7702", { from: FROM, to: FROM, authorizationList: [rpcAuthorization(AUTHORIZATION)] }],
  ];

  for (const [type, request] of CASES) {
    const name = request.data === undefined ? type : `${type} contract creation`;
    it(`signs ${name} byte for byte like Hardhat's local accounts`, async () => {
      const warn = mock.method(console, "warn", () => {});
      try {
        const expected = await rawOf("hardhat", request);
        assert.equal(Transaction.fromHex(expected, false).type, type);
        assert.equal(await rawOf("kms", request), expected);
        // High-S signatures in another wire format are normalized to the same bytes.
        assert.equal(await rawOf("kmsHighS", request), expected);
        assert.equal(await rawOf("kms", request, "eth_signTransaction"), expected);
        assert.equal(warn.mock.callCount(), 0, "a valid authorization is not reported");
      } finally {
        warn.mock.restore();
      }
    });
  }

  it("fails closed when the signature belongs to another key, and sends nothing", async () => {
    const sent = node.raw.length;
    const methods = node.methods.length;
    const connection = await hre.network.create("kmsWrongKey");
    await assert.rejects(
      connection.provider.request({
        method: "eth_sendTransaction",
        params: [{ from: FROM, to: TO, value: "0x1" }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof HardhatPluginError, String(error));
        assert.match(error.message, /invalid signature/);
        return true;
      },
    );
    await connection.close();
    assert.equal(node.raw.length, sent);
    assert.ok(
      !node.methods.slice(methods).includes("eth_sendTransaction"),
      "nothing reached the node unsigned",
    );
  });

  it("refuses a transaction for another chain, and sends nothing", async () => {
    const sent = node.raw.length;
    const connection = await hre.network.create("kms");
    await assert.rejects(
      connection.provider.request({
        method: "eth_sendTransaction",
        params: [{ from: FROM, to: TO, chainId: "0x1" }],
      }),
      /the transaction is for chain 1, but this network is chain 31337/,
    );
    await connection.close();
    assert.equal(node.raw.length, sent);
  });

  it("signs the transaction as it was when requested, whatever the caller changes later", async () => {
    const request = {
      from: FROM,
      to: TO,
      value: "0x1",
      gasPrice: "0x3b9aca00",
      accessList: [{ address: TO, storageKeys: [`0x${"00".repeat(31)}01`] }],
    };
    const expected = await rawOf("hardhat", request);
    const connection = await hre.network.create("kms");
    const tx = structuredClone(request);
    const pending = connection.provider.request({ method: "eth_signTransaction", params: [tx] });
    tx.from = COW_ACCOUNT.address;
    tx.to = FROM;
    tx.value = "0x2";
    tx.accessList[0] = { address: FROM, storageKeys: [] };
    assert.equal(await pending, expected);
    await connection.close();
  });

  it("fills a connection's caches once for several sends", async () => {
    const connection = await hre.network.create("kms");
    const send = async (): Promise<void> => {
      await connection.provider.request({
        method: "eth_sendTransaction",
        params: [{ from: FROM, to: TO, value: "0x1" }],
      });
    };
    const blockReads = (from: number) =>
      node.methods.slice(from).filter((method) => method === "eth_getBlockByNumber").length;
    const start = node.methods.length;
    await send();
    const second = node.methods.length;
    await send();
    await connection.close();
    assert.equal(blockReads(start), 1, "the latest block was read once, for EIP-1559 support");
    assert.equal(blockReads(second), 0);
  });

  it("passes on a request whose transaction is not an object", async () => {
    const signatures = created.zero?.calls.signDigest ?? 0;
    const connection = await hre.network.create("kms");
    const methods = node.methods.length;
    // The other params are not copied either: a function among them is not refused.
    await assert.rejects(
      connection.provider.request({ method: "eth_signTransaction", params: [FROM, () => 1] }),
      (error: unknown) => !String(error).includes("plain data"),
    );
    await connection.close();
    assert.ok(node.methods.slice(methods).includes("eth_signTransaction"));
    assert.equal(created.zero?.calls.signDigest ?? 0, signatures, "no KMS signature");
  });

  it("passes on a transaction that is not plain data when its sender is not a KMS account", async () => {
    const connection = await hre.network.create("kms");
    const start = node.requests.length;
    // The node cannot sign for STRANGER, so it refuses; the request got there.
    await assert.rejects(
      connection.provider.request({
        method: "eth_sendTransaction",
        params: [{ from: STRANGER, to: TO, value: "0x1", extra: () => 1 }],
      }),
      (error: unknown) => !String(error).includes("plain data"),
    );
    await connection.close();
    const sends = node.requests
      .slice(start)
      .filter(({ method }) => method === "eth_sendTransaction")
      .map(({ params }): unknown => (Array.isArray(params) ? params.at(0) : undefined));
    assert.equal(sends.length, 1);
    const [send] = sends;
    assert.ok(typeof send === "object" && send !== null);
    assert.equal(Reflect.get(send, "from"), STRANGER);
    assert.equal(Reflect.get(send, "to"), TO);
  });

  it("passes on a transaction whose `from` is not an address", async () => {
    const signatures = created.zero?.calls.signDigest ?? 0;
    const connection = await hre.network.create("kms");
    await assert.rejects(
      connection.provider.request({
        method: "eth_sendTransaction",
        params: [{ from: "not an address", to: TO }],
      }),
      (error: unknown) => !(error instanceof HardhatPluginError),
    );
    await connection.close();
    assert.equal(created.zero?.calls.signDigest ?? 0, signatures, "no KMS signature");
  });

  it("refuses a KMS account's transaction that is not plain data, and sends nothing", async () => {
    const signatures = created.zero?.calls.signDigest ?? 0;
    const connection = await hre.network.create("kms");
    const methods = node.methods.length;
    for (const method of ["eth_sendTransaction", "eth_signTransaction"]) {
      await assert.rejects(
        connection.provider.request({
          method,
          params: [{ from: FROM, to: TO, value: "0x1", extra: () => 1 }],
        }),
        (error: unknown) => {
          assert.ok(error instanceof HardhatPluginError, String(error));
          assert.match(error.message, /the transaction must be plain data/);
          return true;
        },
      );
    }
    await connection.close();
    assert.deepEqual(node.methods.slice(methods), [], "nothing reached the node");
    assert.equal(created.zero?.calls.signDigest ?? 0, signatures, "no KMS signature");
  });

  describe("transactions without `from`", () => {
    it("uses the network's `from` when it is a KMS account", async () => {
      const expected = await rawOf("hardhat", { from: FROM, to: TO, value: "0x1" });
      assert.equal(await rawOf("kmsFrom", { to: TO, value: "0x1" }), expected);
      assert.equal(
        await rawOf("kmsFrom", { to: TO, value: "0x1" }, "eth_signTransaction"),
        expected,
      );
    });

    it("uses the first of eth_accounts, as Hardhat's automatic sender does", async () => {
      // The node has no accounts, so the first account is the first KMS key, cow.
      const raw = await rawOf("kmsAutomatic", { to: TO, value: "0x1" });
      assert.equal(senderOf(raw), COW_ACCOUNT.address);
      const signed = await rawOf("kmsAutomatic", { to: TO }, "eth_signTransaction");
      assert.equal(senderOf(signed), COW_ACCOUNT.address);
    });

    it("sets `from` itself, also when no gas estimate passes through Hardhat", async () => {
      const raw = await rawOf("kmsAutomatic", { to: TO, value: "0x1", gas: "0x5208" });
      assert.equal(senderOf(raw), COW_ACCOUNT.address);
    });

    it("never lets Hardhat's cached sender reach the node with a KMS address", async () => {
      const connection = await hre.network.create("kmsCow");
      const start = node.requests.length;
      node.accounts = [STRANGER];
      try {
        // eth_accounts fails once: the plugin lists only cow, and Hardhat's automatic sender
        // keeps cow as this connection's sender.
        node.faults.set("eth_accounts", "unavailable");
        await connection.provider.request({ method: "eth_call", params: [{ to: TO }, "latest"] });
        node.faults.delete("eth_accounts");
        // Now the first account is STRANGER, which the node cannot sign for.
        await assert.rejects(
          connection.provider.request({
            method: "eth_sendTransaction",
            params: [{ to: TO, value: "0x1" }],
          }),
        );
      } finally {
        node.faults.delete("eth_accounts");
        node.accounts = [];
        await connection.close();
      }
      const sends = node.requests
        .slice(start)
        .filter(({ method }) => method === "eth_sendTransaction")
        .map(({ params }): unknown => (Array.isArray(params) ? params.at(0) : undefined));
      assert.equal(sends.length, 1);
      const [send] = sends;
      assert.ok(typeof send === "object" && send !== null);
      assert.equal(String(Reflect.get(send, "from")).toLowerCase(), STRANGER.toLowerCase());
    });

    it("refuses a transaction that is not plain data when the default sender is a KMS account", async () => {
      const connection = await hre.network.create("kmsFrom");
      await assert.rejects(
        connection.provider.request({
          method: "eth_sendTransaction",
          params: [{ to: TO, extra: () => 1 }],
        }),
        /the transaction must be plain data/,
      );
      await connection.close();
    });

    it("lets Hardhat's local account sign when it comes first", async () => {
      const signatures = created.zero?.calls.signDigest ?? 0;
      const raw = await rawOf("localFirst", { to: FROM, value: "0x1" });
      assert.equal(senderOf(raw), TO);
      assert.equal(created.zero?.calls.signDigest ?? 0, signatures, "no KMS signature");
    });

    it("passes the request on unchanged when the network's `from` is not a KMS account", async () => {
      const signatures = created.cow?.calls.signDigest ?? 0;
      const connection = await hre.network.create("otherFrom");
      const methods = node.methods.length;
      // The node cannot sign for STRANGER either, so it refuses.
      await assert.rejects(
        connection.provider.request({
          method: "eth_sendTransaction",
          params: [{ to: FROM, value: "0x1" }],
        }),
      );
      await connection.close();
      assert.ok(node.methods.slice(methods).includes("eth_sendTransaction"));
      assert.equal(created.cow?.calls.signDigest ?? 0, signatures, "no KMS signature");
    });
  });

  it("passes a from-less request on unchanged when eth_accounts is not a list", async () => {
    const other = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKms],
      kms: { keys: { cow: vaultKey("cow") } },
      networks: { kmsCow: { type: "http", url: node.url, chainId: 31337, kmsAccounts: ["cow"] } },
    });
    const adapters = serveAdapters(other);
    // A handler registered at run time runs before the plugin's.
    other.hooks.registerHandlers("network", {
      onRequest: async (context, connection, request, next) =>
        request.method === "eth_accounts"
          ? { jsonrpc: "2.0", id: request.id, result: "not a list" }
          : await next(context, connection, request),
    });
    const connection = await other.network.create("kmsCow");
    const start = node.methods.length;
    await assert.rejects(
      connection.provider.request({ method: "eth_sendTransaction", params: [{ to: TO }] }),
      /eth_accounts did not return an array/,
    );
    await connection.close();
    assert.ok(!node.methods.slice(start).includes("eth_sendTransaction"));
    assert.equal(adapters.cow?.calls.signDigest ?? 0, 0);
  });

  describe("EIP-7702 authorization lint", () => {
    it("warns about a high-S authorization", async () => {
      const highS = {
        yParity: 1 - AUTHORIZATION.yParity,
        r: AUTHORIZATION.r,
        s: CURVE_ORDER - AUTHORIZATION.s,
      };
      const warnings = await warningsFor(highS);
      assert.equal(warnings.length, 1, warnings.join("\n"));
      assert.match(warnings[0] ?? "", /^hardhat-kms: authorizationList\[0\] has a high-S/);
    });

    it("warns about an authorization whose authority does not recover", async () => {
      const warnings = await warningsFor({ yParity: 0, r: CURVE_ORDER + 1n, s: 1n });
      assert.equal(warnings.length, 1, warnings.join("\n"));
      assert.match(warnings[0] ?? "", /authorizationList\[0\]'s signature does not recover/);
    });
  });
});

describe("sending from a KMS account on a simulated network", () => {
  const ONE_ETHER = 10n ** 18n;
  const COW = getAddress(COW_ACCOUNT.address);

  async function connect() {
    const hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKms, hardhatViem],
      kms: { keys: { cow: vaultKey("cow") }, simulatedBalance: ONE_ETHER },
      networks: { local: { type: "edr-simulated", kmsAccounts: ["cow"] } },
    });
    serveAdapters(hre);
    return await hre.network.create("local");
  }

  it("sends ETH and deploys a contract with eth_sendTransaction", async () => {
    const { provider } = await connect();
    const transfer = await receiptOf(
      provider,
      await provider.request({
        method: "eth_sendTransaction",
        params: [{ from: COW, to: TO, value: "0x1" }],
      }),
    );
    assert.equal(transfer.status, "0x1");
    assert.equal(getAddress(String(transfer.from)), COW);

    const deployment = await receiptOf(
      provider,
      await provider.request({
        method: "eth_sendTransaction",
        params: [{ from: COW, data: INIT_CODE }],
      }),
    );
    assert.equal(deployment.status, "0x1");
    assert.equal(getAddress(String(deployment.from)), COW);
    const answer = await provider.request({
      method: "eth_call",
      params: [{ to: deployment.contractAddress }, "latest"],
    });
    assert.equal(BigInt(String(answer)), 42n);
  });

  it("sends through viem's wallet client", async () => {
    const { viem } = await connect();
    const wallet = await viem.getWalletClient(COW);
    const publicClient = await viem.getPublicClient();
    const hash = await wallet.sendTransaction({ to: getAddress(TO), value: 1n });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    assert.equal(getAddress(receipt.from), COW);
  });

  it("signs with eth_signTransaction without sending", async () => {
    const { provider } = await connect();
    const nonce = async (): Promise<unknown> =>
      await provider.request({ method: "eth_getTransactionCount", params: [COW, "pending"] });
    const initial = await nonce();
    const raw = await provider.request({
      method: "eth_signTransaction",
      params: [{ from: COW, to: TO, value: "0x1" }],
    });
    assert.ok(typeof raw === "string");
    assert.equal(senderOf(raw), COW);
    assert.equal(await nonce(), initial, "the nonce did not move");
    // The signed transaction is valid: the node accepts it.
    const hash = await provider.request({ method: "eth_sendRawTransaction", params: [raw] });
    assert.equal((await receiptOf(provider, hash)).status, "0x1");
  });
});
