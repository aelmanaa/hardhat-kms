// dispatch() with a fake node and fake KMS adapters: the account list, message and typed-data
// signing, the copy of a transaction request, and what passes on to the rest of the chain.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardhatError } from "@nomicfoundation/hardhat-errors";
import { configVariable } from "hardhat/config";
import { HardhatPluginError } from "hardhat/plugins";
import { recoverMessageAddress, recoverTypedDataAddress } from "viem";

import { kmsAccountsSentence } from "../../../src/internal/rpc/dispatcher.ts";
import {
  COW,
  dispatchFixture,
  ErrorAnswer,
  OTHER,
  resultOf,
  ZERO,
} from "../../helpers/dispatch-fixture.ts";
import { vaultKey } from "../../helpers/vault-key.ts";

const MESSAGE = "0x68656c6c6f"; // "hello"
const SENTENCE = ((): string => {
  const sentence = kmsAccountsSentence([COW, ZERO]);
  assert.ok(sentence !== undefined);
  return sentence;
})();

/** A thrown error that says the account is unknown, as Hardhat's simulated network throws it. */
function unknownAccount(): Error {
  return Object.assign(new Error(`Unknown account ${OTHER}`), { code: -32000 });
}

/** An error-shaped value that is not an Error instance, as an error made in a `vm` context is. */
function errorLike(): Error {
  const error = Object.assign(new Error("unknown account"), { code: -32000 });
  Object.setPrototypeOf(error, Object.prototype);
  return error;
}

/** A field that structuredClone cannot copy. */
const notPlainData = (): string => "0x";

const TYPED_DATA = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "chainId", type: "uint256" },
    ],
    Mail: [{ name: "contents", type: "string" }],
  },
  primaryType: "Mail",
  domain: { name: "Test", chainId: 31337 },
  message: { contents: "hello" },
} as const;

/** The requests of each signing method that name `address`. */
function signingRequests(address: Uint8Array) {
  return [
    ["eth_sign", [address, MESSAGE]],
    ["personal_sign", [MESSAGE, address]],
    ["eth_signTypedData_v4", [address, TYPED_DATA]],
  ] as const;
}

/** The signature in a response, checked to recover to an address. */
async function assertSignedBy(result: unknown, address: string): Promise<void> {
  assert.ok(typeof result === "string" && result.startsWith("0x"), String(result));
  const signer = await recoverMessageAddress({
    message: { raw: MESSAGE },
    signature: `0x${result.slice(2)}`,
  });
  assert.equal(signer, address);
}

describe("dispatch: accounts", () => {
  it("lists the node's accounts, then the KMS addresses it does not list, for both methods", async () => {
    const fixture = await dispatchFixture();
    fixture.answers.set("eth_accounts", () => [ZERO.toLowerCase(), 5, OTHER]);
    for (const method of ["eth_accounts", "eth_requestAccounts"]) {
      const response = await fixture.request(method);
      assert.deepEqual(response, {
        jsonrpc: "2.0",
        id: 7,
        result: [ZERO.toLowerCase(), OTHER, COW],
      });
    }
    // eth_requestAccounts goes on as eth_accounts.
    assert.deepEqual(
      fixture.forwarded.map((request) => request.method),
      ["eth_accounts", "eth_accounts"],
    );
  });

  it("lists the KMS addresses only when the node's list fails or is not a list", async () => {
    const fixture = await dispatchFixture();
    fixture.answers.set("eth_accounts", () => {
      throw new Error("method not found");
    });
    assert.deepEqual(resultOf(await fixture.request("eth_accounts")), [COW, ZERO]);
    fixture.answers.set("eth_accounts", () => ({ accounts: [OTHER] }));
    assert.deepEqual(resultOf(await fixture.request("eth_accounts")), [COW, ZERO]);
    fixture.answers.set("eth_accounts", () => new ErrorAnswer(-32601, "no accounts"));
    assert.deepEqual(resultOf(await fixture.request("eth_accounts")), [COW, ZERO]);
  });

  it("passes everything on unchanged on a connection without KMS keys", async () => {
    const fixture = await dispatchFixture({
      networks: { remote: { type: "http", url: "http://127.0.0.1:1" } },
    });
    fixture.answers.set("eth_accounts", () => {
      throw new Error("method not found");
    });
    await assert.rejects(fixture.request("eth_accounts"), /method not found/);
    fixture.answers.set("eth_accounts", () => ["not an address", 5]);
    assert.deepEqual(resultOf(await fixture.request("eth_accounts")), ["not an address", 5]);
  });

  it("looks the addresses up again after a failed lookup", async () => {
    const fixture = await dispatchFixture({ failLookups: 1 });
    await assert.rejects(fixture.accounts.addresses(), /the provider call failed/);
    assert.deepEqual(await fixture.accounts.addresses(), [COW, ZERO]);
  });

  it("knows the KMS addresses only once they are looked up, with no KMS call", async () => {
    const fixture = await dispatchFixture();
    assert.equal(fixture.accounts.hasKnownAddresses, false);
    assert.equal(fixture.accounts.isKnownKmsAccount(COW.toLowerCase()), false);
    assert.equal(fixture.adapters.length, 0);
    await fixture.accounts.addresses();
    assert.equal(fixture.accounts.hasKnownAddresses, true);
    assert.equal(fixture.accounts.isKnownKmsAccount(COW.toLowerCase()), true);
    assert.equal(fixture.accounts.isKnownKmsAccount(OTHER.toLowerCase()), false);
  });

  it("refuses two keys of one account, with both names", async () => {
    const fixture = await dispatchFixture({
      keys: { cow: vaultKey("cow"), copy: vaultKey("copy", COW) },
      networks: {
        remote: { type: "http", url: "http://127.0.0.1:1", kmsAccounts: ["cow", "copy"] },
      },
    });
    await assert.rejects(fixture.accounts.addresses(), (error: unknown) => {
      assert.ok(error instanceof HardhatPluginError, String(error));
      assert.equal(
        error.message,
        `load accounts: copy and cow are the same account (${COW}); list each key once`,
      );
      return true;
    });
  });
});

describe("dispatch: keys chosen with --kms", () => {
  const AZURE = { provider: "azure", keyId: "https://v.vault.azure.net/keys/k" } as const;
  const URL = "http://127.0.0.1:1";

  it("refuses one that is already a config key, by both names", async () => {
    const fixture = await dispatchFixture({
      keys: { cloud: AZURE, again: AZURE },
      networks: {
        remote: { type: "http", url: URL, kmsAccounts: ["cloud"] },
        cli: { type: "http", url: URL, kmsAccounts: ["again"] },
      },
      commandLineFrom: "cli",
    });
    await assert.rejects(fixture.accounts.addresses(), (error: unknown) => {
      assert.ok(error instanceof HardhatPluginError, String(error));
      assert.equal(
        error.message,
        'azure, load accounts: again is already networks.remote.kmsAccounts[0] ("cloud"); use one of them',
      );
      return true;
    });
  });

  it("names an inline config key by its path only, at its index", async () => {
    const fixture = await dispatchFixture({
      keys: { cow: vaultKey("cow"), again: AZURE },
      networks: {
        remote: { type: "http", url: URL, kmsAccounts: ["cow", AZURE] },
        cli: { type: "http", url: URL, kmsAccounts: ["again"] },
      },
      commandLineFrom: "cli",
    });
    await assert.rejects(
      fixture.accounts.addresses(),
      (error: unknown) =>
        error instanceof HardhatPluginError &&
        error.message ===
          "azure, load accounts: again is already networks.remote.kmsAccounts[1]; use one of them",
    );
  });

  it("does not read a pinned config key, and takes a key it cannot identify as new", async () => {
    // Reading the pinned key would ask for an unset variable.
    const pinned = {
      provider: "azure",
      keyId: configVariable("HARDHAT_KMS_TEST_UNSET_331"),
      address: OTHER,
    } as const;
    const fixture = await dispatchFixture({
      keys: { pinned, cow: vaultKey("cow"), zero: vaultKey("zero") },
      networks: {
        remote: { type: "http", url: URL, kmsAccounts: ["pinned", "cow"] },
        cli: { type: "http", url: URL, kmsAccounts: ["zero"] },
      },
      commandLineFrom: "cli",
    });
    assert.deepEqual(await fixture.accounts.addresses(), [OTHER, COW, ZERO]);
  });

  it("reads no config key when no key is chosen with --kms", async () => {
    const unread = {
      provider: "azure",
      keyId: configVariable("HARDHAT_KMS_TEST_UNSET_331"),
    } as const;
    const fixture = await dispatchFixture({
      keys: { unread },
      networks: { remote: { type: "http", url: URL, kmsAccounts: ["unread"] } },
    });
    // The lookup fails when it creates the key's adapter, not when it reads the key's id.
    await assert.rejects(fixture.accounts.addresses(), /creating the adapter failed/);
  });
});

describe("dispatch: messages and typed data", () => {
  it("signs eth_sign and personal_sign for a KMS address", async () => {
    const fixture = await dispatchFixture();
    for (const [method, params] of [
      ["eth_sign", [COW, MESSAGE]],
      ["personal_sign", [MESSAGE, COW.toLowerCase()]],
    ] as const) {
      const response = await fixture.request(method, params);
      assert.equal(response.jsonrpc, "2.0");
      assert.equal(response.id, 7);
      await assertSignedBy(resultOf(response), COW);
    }
    assert.deepEqual(fixture.forwarded, []);
  });

  it("refuses a KMS address given as 20 bytes, for each signing method, before any signature", async () => {
    const bytes = Buffer.from(COW.slice(2), "hex");
    for (const address of [bytes, new Uint8Array(bytes)]) {
      for (const [method, params] of signingRequests(address)) {
        const fixture = await dispatchFixture();
        await assert.rejects(
          fixture.request(method, params),
          (error: unknown) =>
            error instanceof HardhatPluginError &&
            error.message ===
              `${method}: the address must be a hex string such as ${COW}, not a byte array`,
        );
        assert.deepEqual(fixture.forwarded, [], method);
        assert.deepEqual(fixture.reads, [], method);
        assert.ok(fixture.adapters.every((adapter) => adapter.calls.signDigest === 0));
      }
    }
  });

  it("passes an address of bytes on when it is no KMS account's address, for each signing method", async () => {
    const other = Buffer.from(OTHER.slice(2), "hex");
    const cow = Buffer.from(COW.slice(2), "hex");
    for (const address of [
      other,
      new Uint8Array(other),
      cow.subarray(1),
      new Uint8Array([...cow, 0]),
    ]) {
      for (const [method, params] of signingRequests(address)) {
        const fixture = await dispatchFixture();
        fixture.answers.set(method, () => "0xsigned");
        assert.equal(resultOf(await fixture.request(method, params)), "0xsigned");
        assert.equal(fixture.forwarded.length, 1);
        assert.equal(fixture.forwarded[0]?.params, params);
        assert.ok(fixture.adapters.every((adapter) => adapter.calls.signDigest === 0));
      }
    }
  });

  it("passes eth_sign and personal_sign for other addresses on, with no KMS call", async () => {
    const fixture = await dispatchFixture();
    fixture.answers.set("eth_sign", () => "0xsigned");
    fixture.answers.set("personal_sign", () => "0xsigned");
    for (const [method, params] of [
      ["eth_sign", [OTHER, MESSAGE]],
      ["eth_sign", ["not an address", MESSAGE]],
      ["eth_sign", [new Uint8Array(19), MESSAGE]],
      ["personal_sign", [MESSAGE, OTHER]],
      ["personal_sign", [COW, MESSAGE]],
    ] as const) {
      assert.equal(resultOf(await fixture.request(method, params)), "0xsigned");
    }
    assert.equal(fixture.forwarded.length, 5);
    // Only the lookups for the address params, none for the malformed ones.
    assert.ok(fixture.adapters.every((adapter) => adapter.calls.signDigest === 0));
  });

  it("makes no KMS call for a param that is not an address", async () => {
    const fixture = await dispatchFixture();
    fixture.answers.set("eth_sign", () => "0xsigned");
    await fixture.request("eth_sign", ["not an address", MESSAGE]);
    // Text around an address, a list that reads as one, and 19 bytes.
    await fixture.request("eth_sign", [`zz${COW}`, MESSAGE]);
    await fixture.request("eth_sign", [`${COW}zz`, MESSAGE]);
    await fixture.request("eth_sign", [[COW], MESSAGE]);
    await fixture.request("eth_sign", [new Uint8Array(19), MESSAGE]);
    // A transaction whose from is not an address, and a wallet send without from.
    fixture.answers.set("eth_signTransaction", () => "0xraw");
    await fixture.request("eth_signTransaction", [{ from: "me", to: ZERO }]);
    fixture.answers.set("wallet_sendTransaction", () => "0xhash");
    await fixture.request("wallet_sendTransaction", [{ to: ZERO }]);
    // Another method whose first param names a KMS account.
    fixture.answers.set("eth_call", () => "0x");
    await fixture.request("eth_call", [{ from: COW, to: ZERO }]);
    await fixture.request("eth_signTypedData_v4", [5, TYPED_DATA]).catch(() => undefined);
    assert.equal(fixture.adapters.length, 0);
    assert.equal(fixture.accounts.hasKnownAddresses, false);
  });

  it("reads params given as an object as no params", async () => {
    const fixture = await dispatchFixture();
    fixture.answers.set("eth_sign", () => "0xsigned");
    assert.equal(resultOf(await fixture.request("eth_sign", { 0: COW, 1: MESSAGE })), "0xsigned");
  });

  it("signs typed data for this chain, and refuses another chain", async () => {
    const fixture = await dispatchFixture();
    const signature = resultOf(await fixture.request("eth_signTypedData_v4", [COW, TYPED_DATA]));
    assert.ok(typeof signature === "string");
    assert.equal(
      await recoverTypedDataAddress({
        ...TYPED_DATA,
        domain: { ...TYPED_DATA.domain, chainId: 31337n },
        signature: `0x${signature.slice(2)}`,
      }),
      COW,
    );
    await assert.rejects(
      fixture.request("eth_signTypedData_v4", [
        COW,
        { ...TYPED_DATA, domain: { ...TYPED_DATA.domain, chainId: 1 } },
      ]),
      (error: unknown) =>
        error instanceof HardhatPluginError &&
        error.message ===
          "eth_signTypedData_v4: the typed data is for chain 1, but this network is chain 31337. Set `kms.allowCrossChainTypedData: true` to sign typed data for other chains",
    );
    fixture.answers.set("eth_signTypedData_v4", () => "0xsigned");
    assert.equal(
      resultOf(await fixture.request("eth_signTypedData_v4", [OTHER, TYPED_DATA])),
      "0xsigned",
    );
  });
});

describe("dispatch: wallet_sendTransaction", () => {
  it("answers a KMS sender with a JSON-RPC error, and sends nothing on", async () => {
    const fixture = await dispatchFixture();
    assert.deepEqual(await fixture.request("wallet_sendTransaction", [{ from: COW, to: ZERO }]), {
      jsonrpc: "2.0",
      id: 7,
      error: {
        code: -32601,
        message: `wallet_sendTransaction is not available for the KMS account ${COW}. Send with eth_sendTransaction, which the plugin signs.`,
      },
    });
    assert.deepEqual(fixture.forwarded, []);
  });
});

describe("dispatch: transaction requests that pass on", () => {
  it("passes on a transaction from another address, or not an object, unchanged", async () => {
    const fixture = await dispatchFixture();
    fixture.answers.set("eth_signTransaction", () => "0xraw");
    const tx = { from: OTHER, to: ZERO };
    for (const params of [[tx], ["0x"], []]) {
      assert.equal(resultOf(await fixture.request("eth_signTransaction", params)), "0xraw");
      assert.equal(fixture.forwarded.at(-1)?.params, params);
    }
  });

  it("passes on a transaction whose from is not an address unchanged", async () => {
    const fixture = await dispatchFixture();
    fixture.answers.set("eth_signTransaction", () => "0xraw");
    const params = [{ from: "me", to: ZERO }];
    await fixture.request("eth_signTransaction", params);
    assert.equal(fixture.forwarded.at(-1)?.params, params);
  });

  it("sets the default sender on a transaction without from, and passes it on", async () => {
    const fixture = await dispatchFixture();
    fixture.answers.set("eth_signTransaction", () => "0xraw");
    fixture.answers.set("eth_sendTransaction", () => "0xhash");
    for (const sender of [OTHER, "not an address"]) {
      fixture.defaultSender = sender;
      const tx = { to: ZERO, value: "0x1" };
      for (const method of ["eth_signTransaction", "eth_sendTransaction"]) {
        await fixture.request(method, [tx, "extra"]);
        assert.deepEqual(fixture.forwarded.at(-1)?.params, [{ ...tx, from: sender }, "extra"]);
        assert.deepEqual(tx, { to: ZERO, value: "0x1" }, "the caller's object is not changed");
      }
    }
  });

  it("passes a transaction without from on unchanged when there is no default sender", async () => {
    const fixture = await dispatchFixture();
    fixture.answers.set("eth_signTransaction", () => "0xraw");
    const params = [{ to: ZERO }];
    await fixture.request("eth_signTransaction", params);
    assert.equal(fixture.forwarded.at(-1)?.params, params);
  });

  it("refuses a KMS account's transaction that is not plain data, and passes another on", async () => {
    const fixture = await dispatchFixture();
    fixture.answers.set("eth_signTransaction", () => "0xraw");
    const data = notPlainData;
    await assert.rejects(
      fixture.request("eth_signTransaction", [{ from: COW, to: ZERO, data }]),
      (error: unknown) =>
        error instanceof HardhatPluginError &&
        error.message ===
          "eth_signTransaction: the transaction must be plain data (JSON values, bigints and byte arrays)",
    );
    const params = [{ from: OTHER, to: ZERO, data }];
    assert.equal(resultOf(await fixture.request("eth_signTransaction", params)), "0xraw");
    assert.equal(fixture.forwarded.at(-1)?.params, params);
    fixture.defaultSender = OTHER;
    const noFrom = { to: ZERO, data };
    await fixture.request("eth_signTransaction", [noFrom]);
    assert.deepEqual(fixture.forwarded.at(-1)?.params, [{ ...noFrom, from: OTHER }]);
  });

  it("refuses a KMS account's from given as 20 bytes, before any signature or node request", async () => {
    const bytes = Buffer.from(COW.slice(2), "hex");
    for (const method of ["eth_signTransaction", "eth_sendTransaction"]) {
      for (const from of [bytes, new Uint8Array(bytes)]) {
        const fixture = await dispatchFixture();
        await assert.rejects(
          fixture.request(method, [{ from, to: ZERO, value: "0x1" }]),
          (error: unknown) =>
            error instanceof HardhatPluginError &&
            error.message ===
              `${method}: \`from\` must be a hex address string such as ${COW}, not a byte array`,
        );
        assert.deepEqual(fixture.forwarded, [], method);
        assert.deepEqual(fixture.reads, [], method);
        assert.ok(fixture.adapters.every((adapter) => adapter.calls.signDigest === 0));
      }
    }
  });

  it("passes a from of bytes on unchanged when it is no KMS account's address", async () => {
    const other = Buffer.from(OTHER.slice(2), "hex");
    const cow = Buffer.from(COW.slice(2), "hex");
    for (const method of ["eth_signTransaction", "eth_sendTransaction"]) {
      // Another account's 20 bytes, and a KMS address cut to 19 bytes or grown to 21.
      for (const from of [
        other,
        new Uint8Array(other),
        cow.subarray(1),
        new Uint8Array([...cow, 0]),
      ]) {
        const fixture = await dispatchFixture();
        fixture.answers.set(method, () => "0xanswer");
        const params = [{ from, to: ZERO }];
        assert.equal(resultOf(await fixture.request(method, params)), "0xanswer");
        assert.equal(fixture.forwarded.length, 1);
        assert.equal(fixture.forwarded[0]?.params, params);
        assert.deepEqual(fixture.reads, []);
        assert.ok(fixture.adapters.every((adapter) => adapter.calls.signDigest === 0));
      }
    }
  });

  it("passes other methods that name a KMS address on unchanged", async () => {
    const fixture = await dispatchFixture();
    fixture.answers.set("eth_call", () => "0x01");
    fixture.answers.set("eth_estimateGas", () => "0x5208");
    assert.equal(resultOf(await fixture.request("eth_call", [{ from: COW, to: ZERO }])), "0x01");
    assert.equal(
      resultOf(await fixture.request("eth_estimateGas", [{ from: COW, to: ZERO }])),
      "0x5208",
    );
    assert.equal(fixture.forwarded.length, 2);
  });
});

describe("dispatch: unknown-account errors", () => {
  it("get the KMS addresses, for every method that names an account", async () => {
    for (const [method, params] of [
      ["eth_sendTransaction", [{ from: OTHER, to: ZERO }]],
      ["eth_signTransaction", [{ from: OTHER, to: ZERO }]],
      ["eth_sign", [OTHER, MESSAGE]],
      ["personal_sign", [MESSAGE, OTHER]],
      ["eth_signTypedData_v4", [OTHER, TYPED_DATA]],
    ] as const) {
      const fixture = await dispatchFixture();
      const error = unknownAccount();
      fixture.answers.set(method, () => {
        throw error;
      });
      await assert.rejects(fixture.request(method, params), (thrown: unknown) => {
        assert.equal(thrown, error, "the same error object");
        assert.equal(error.message, `Unknown account ${OTHER}. ${SENTENCE}`);
        assert.ok(error.stack?.startsWith(`Error: Unknown account ${OTHER}. ${SENTENCE}\n`));
        return true;
      });
    }
  });

  it("get them in an error answer too, which keeps its code", async () => {
    const fixture = await dispatchFixture();
    fixture.answers.set("eth_sign", () => new ErrorAnswer(-32000, "unknown account", { x: 1 }));
    const response = await fixture.request("eth_sign", [OTHER, MESSAGE]);
    assert.deepEqual(response, {
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32000, message: `unknown account. ${SENTENCE}`, data: { x: 1 } },
    });
  });

  it("get them in Hardhat's HHE716 and its formatted message", async () => {
    const fixture = await dispatchFixture();
    const error = new HardhatError(HardhatError.ERRORS.CORE.NETWORK.NOT_LOCAL_ACCOUNT, {
      account: OTHER,
    });
    const formatted = error.formattedMessage;
    fixture.answers.set("personal_sign", () => {
      throw error;
    });
    await assert.rejects(fixture.request("personal_sign", [MESSAGE, OTHER]), (thrown) => {
      assert.equal(thrown, error);
      assert.equal(error.formattedMessage, `${formatted} ${SENTENCE}`);
      assert.ok(error.message.endsWith(SENTENCE));
      return true;
    });
  });

  it("are left as they are when they are not about an unknown account, or not for a sender method", async () => {
    const fixture = await dispatchFixture();
    const refusal = Object.assign(new Error("insufficient funds"), { code: -32000 });
    fixture.answers.set("eth_sign", () => {
      throw refusal;
    });
    await assert.rejects(fixture.request("eth_sign", [OTHER, MESSAGE]), (thrown) => {
      assert.equal(thrown, refusal);
      assert.equal(refusal.message, "insufficient funds");
      return true;
    });
    fixture.answers.set("personal_sign", () => new ErrorAnswer(-32000, "insufficient funds"));
    assert.deepEqual(await fixture.request("personal_sign", [MESSAGE, OTHER]), {
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32000, message: "insufficient funds" },
    });
    const unknown = unknownAccount();
    fixture.answers.set("eth_call", () => {
      throw unknown;
    });
    await assert.rejects(fixture.request("eth_call", [{ from: OTHER }]), () => {
      assert.equal(unknown.message, `Unknown account ${OTHER}`);
      return true;
    });
    fixture.answers.set("eth_call", () => new ErrorAnswer(-32000, "unknown account"));
    assert.deepEqual(await fixture.request("eth_call", [{ from: OTHER }]), {
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32000, message: "unknown account" },
    });
    // A thrown value that is not an Error instance is rethrown as it is.
    const notAnError = errorLike();
    assert.equal(Object.getPrototypeOf(notAnError), Object.prototype, "not an Error instance");
    fixture.answers.set("eth_sign", () => {
      throw notAnError;
    });
    await assert.rejects(fixture.request("eth_sign", [OTHER, MESSAGE]), (thrown) => {
      assert.equal(thrown, notAnError);
      assert.equal(notAnError.message, "unknown account");
      return true;
    });
  });

  it("are left as they are when the KMS addresses cannot be read", async () => {
    const fixture = await dispatchFixture({ failLookups: 10 });
    // A param that is not an address: the request goes on with no lookup, and fails.
    const params = ["not an address", MESSAGE];
    const error = unknownAccount();
    fixture.answers.set("eth_sign", () => {
      throw error;
    });
    await assert.rejects(fixture.request("eth_sign", params), (thrown) => thrown === error);
    assert.equal(error.message, `Unknown account ${OTHER}`);
    fixture.answers.set("eth_sign", () => new ErrorAnswer(-32000, "unknown account"));
    assert.deepEqual(await fixture.request("eth_sign", params), {
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32000, message: "unknown account" },
    });
  });

  it("are left as they are when the connection has no KMS address to list", async () => {
    const fixture = await dispatchFixture({
      keys: {},
      networks: { remote: { type: "http", url: "http://127.0.0.1:1", kmsAccounts: [] } },
    });
    const error = unknownAccount();
    fixture.answers.set("eth_sign", () => {
      throw error;
    });
    await assert.rejects(fixture.request("eth_sign", [OTHER, MESSAGE]));
    assert.equal(error.message, `Unknown account ${OTHER}`);
  });

  it("are left whole when the error cannot be changed, and keep a stack that is not a string", async () => {
    const fixture = await dispatchFixture();
    const frozen = unknownAccount();
    Object.freeze(frozen);
    fixture.answers.set("eth_sign", () => {
      throw frozen;
    });
    await assert.rejects(fixture.request("eth_sign", [OTHER, MESSAGE]), (thrown) => {
      assert.equal(thrown, frozen);
      assert.equal(frozen.message, `Unknown account ${OTHER}`);
      return true;
    });
    // A HardhatError whose message cannot be set: its formatted message is put back.
    const hardhat = new HardhatError(HardhatError.ERRORS.CORE.NETWORK.NOT_LOCAL_ACCOUNT, {
      account: OTHER,
    });
    const formatted = hardhat.formattedMessage;
    Object.defineProperty(hardhat, "message", { value: hardhat.message, writable: false });
    fixture.answers.set("personal_sign", () => {
      throw hardhat;
    });
    await assert.rejects(fixture.request("personal_sign", [MESSAGE, OTHER]));
    assert.equal(hardhat.formattedMessage, formatted);
    // A stack that cannot be set: the message is put back.
    const stuck = unknownAccount();
    const message = stuck.message;
    Object.defineProperty(stuck, "stack", {
      get: () => `Error: ${message}`,
      set: () => {
        throw new TypeError("read-only stack");
      },
    });
    fixture.answers.set("eth_sign", () => {
      throw stuck;
    });
    await assert.rejects(fixture.request("eth_sign", [OTHER, MESSAGE]));
    assert.equal(stuck.message, message);
    // No stack at all: only the message changes.
    const bare = unknownAccount();
    Object.defineProperty(bare, "stack", { value: undefined, writable: true });
    fixture.answers.set("eth_sign", () => {
      throw bare;
    });
    await assert.rejects(fixture.request("eth_sign", [OTHER, MESSAGE]));
    assert.equal(bare.message, `Unknown account ${OTHER}. ${SENTENCE}`);
    assert.equal(bare.stack, undefined);
  });
});
