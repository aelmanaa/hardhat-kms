// The library account against viem's own `privateKeyToAccount` on Hardhat's first test key: a
// deterministic fake KMS (RFC 6979, as viem) must give the same bytes for every method. Every
// refusal must come before any KMS call, which the fake adapter counts.
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { HardhatPluginError } from "hardhat/plugins";
import { serializeTransaction, type SignedAuthorization, type TransactionSerializable } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  type AccountConnection,
  createKmsNetworkConnection,
  type LoadViem,
  loadViem,
} from "../../../src/internal/viem/account.ts";
import type { KmsAccountOptions } from "../../../src/types.ts";
import type { FakeAdapter } from "../../helpers/fake-adapter.ts";
import {
  ADDRESS,
  assertRefused,
  CHAIN_ID,
  kmsCalls,
  setup,
  VIEM_ACCOUNT,
} from "../../helpers/library-account.ts";
import { COW_ACCOUNT, EIP712_MAIL, HARDHAT_ACCOUNT_0 } from "../../helpers/vectors.ts";

const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DELEGATE = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const DELEGATE_LOWERCASE = "0x5fbdb2315678afecb367f032d93f642f64180aa3";

/** Asserts that `run` is refused because the connection is closed, with no KMS call. */
async function assertClosed(
  adapter: FakeAdapter,
  operation: string,
  run: () => Promise<unknown>,
): Promise<void> {
  const before = kmsCalls(adapter);
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof HardhatPluginError);
    assert.equal(error.message, closedMessage(operation));
    return true;
  });
  assert.equal(kmsCalls(adapter), before, "a closed connection must not call the KMS");
}

const LEGACY: TransactionSerializable = {
  type: "legacy",
  chainId: CHAIN_ID,
  nonce: 7,
  gas: 21_000n,
  gasPrice: 1_000_000_000n,
  to: TO,
  value: 10n ** 15n,
};

const EIP2930: TransactionSerializable = {
  type: "eip2930",
  chainId: CHAIN_ID,
  nonce: 1,
  gas: 50_000n,
  gasPrice: 2n,
  to: TO,
  data: "0xdeadbeef",
  accessList: [{ address: TO, storageKeys: [`0x${"01".repeat(32)}`] }],
};

const EIP1559: TransactionSerializable = {
  chainId: CHAIN_ID,
  nonce: 0,
  gas: 21_000n,
  maxFeePerGas: 3_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  to: TO,
  value: 1n,
};

const CREATION: TransactionSerializable = {
  type: "eip1559",
  chainId: CHAIN_ID,
  nonce: 2,
  gas: 100_000n,
  maxFeePerGas: 2n,
  maxPriorityFeePerGas: 1n,
  data: "0x6080604052",
};

const AUTHORITY = privateKeyToAccount(`0x${COW_ACCOUNT.secretKey}`);

/** An authorization signed by another key, for an EIP-7702 transaction's list. */
async function signedAuthorization(): Promise<SignedAuthorization> {
  return await AUTHORITY.signAuthorization({
    contractAddress: DELEGATE,
    chainId: CHAIN_ID,
    nonce: 0,
  });
}

/** The fields of an EIP-7702 transaction, without its authorization list. */
const EIP7702_FIELDS = {
  type: "eip7702",
  chainId: CHAIN_ID,
  nonce: 3,
  gas: 80_000n,
  maxFeePerGas: 2n,
  maxPriorityFeePerGas: 1n,
  to: AUTHORITY.address,
} as const;

/** An EIP-7702 transaction carrying an authorization signed by another key. */
async function eip7702(): Promise<TransactionSerializable> {
  return { ...EIP7702_FIELDS, authorizationList: [await signedAuthorization()] };
}

const TYPED_DATA = {
  domain: {
    name: "Permit",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
  },
  types: {
    Permit: [
      { name: "owner", type: "address" },
      { name: "value", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "Permit",
  message: { owner: ADDRESS, value: 10n ** 18n, deadline: 2n ** 64n },
} as const;

/** A setup and its account. */
async function setupAccount(options: Parameters<typeof setup>[0] = {}) {
  const context = setup(options);
  const created = await createKmsNetworkConnection(context.connection).getAccount(ADDRESS);
  return { ...context, account: created };
}

/** A loader that fails as `import("viem")` does in a project without viem. */
const missingViem: LoadViem = async () => {
  const error = Object.assign(new Error("Cannot find package 'viem'"), {
    code: "ERR_MODULE_NOT_FOUND",
  });
  throw await Promise.resolve(error);
};

/** A loader that fails with an error whose `code` is the given value. */
const failingViem =
  (code: unknown): LoadViem =>
  async () => {
    throw await Promise.resolve(Object.assign(new TypeError("no"), { code }));
  };

/** The full message of the viem-missing error, for the reason given. */
const viemMissingMessage = (reason: string): string =>
  `getAccount: connection.kms.getAccount needs the viem package, which could not be loaded (${reason}). Install it with \`npm install --save-dev viem\``;

/** The full message of the closed-connection error, for the method given. */
const closedMessage = (operation: string): string =>
  `${operation}: the connection to network local is closed, so its KMS accounts no longer sign. Get the account from an open connection`;

/**
 * Calls a method with values its type does not allow, as plain JavaScript can.
 *
 * @param method - The method; account methods do not use `this`.
 * @param args - The arguments.
 * @returns What the method returns, awaited.
 */
async function untyped(
  method: (...args: never[]) => unknown,
  ...args: unknown[]
): Promise<unknown> {
  const result: unknown = Reflect.apply(method, undefined, args);
  return await result;
}

afterEach(() => {
  mock.restoreAll();
});

describe("connection.kms.getAccount", () => {
  it("has the address and public key viem derives from the same key, after one KMS call", async () => {
    const { adapter, connection } = setup();
    const account = await createKmsNetworkConnection(connection).getAccount(ADDRESS.toLowerCase());
    assert.equal(account.address, ADDRESS);
    assert.equal(account.publicKey, VIEM_ACCOUNT.publicKey);
    assert.equal(account.type, "local");
    assert.equal(account.source, "hardhat-kms");
    assert.equal(kmsCalls(adapter), 1);
  });

  describe("returns viem's bytes", () => {
    for (const [name, adapterOptions] of [
      ["DER, low S", { format: "der" }],
      ["compact, high S", { format: "compact", highS: true }],
    ] as const) {
      describe(`with ${name} signatures`, () => {
        it("for messages: text, hex and bytes", async () => {
          const { connection } = setup({ adapter: adapterOptions });
          const account = await createKmsNetworkConnection(connection).getAccount(ADDRESS);
          for (const message of [
            "hello",
            "",
            { raw: "0xdeadbeef" },
            { raw: hex("00ff10") },
          ] as const) {
            assert.equal(
              await account.signMessage({ message }),
              await VIEM_ACCOUNT.signMessage({ message }),
            );
          }
        });

        it("for typed data, with and without EIP712Domain in types", async () => {
          const { connection } = setup({ adapter: adapterOptions });
          const account = await createKmsNetworkConnection(connection).getAccount(ADDRESS);
          assert.equal(
            await account.signTypedData(TYPED_DATA),
            await VIEM_ACCOUNT.signTypedData(TYPED_DATA),
          );
          const withDomain = {
            ...TYPED_DATA,
            domain: { ...TYPED_DATA.domain, chainId: BigInt(CHAIN_ID) },
            types: {
              ...TYPED_DATA.types,
              EIP712Domain: [
                { name: "name", type: "string" },
                { name: "version", type: "string" },
                { name: "chainId", type: "uint256" },
                { name: "verifyingContract", type: "address" },
              ],
            },
          } as const;
          assert.equal(
            await account.signTypedData(withDomain),
            await VIEM_ACCOUNT.signTypedData(withDomain),
          );
          const noDomain = {
            types: TYPED_DATA.types,
            primaryType: "Permit",
            message: TYPED_DATA.message,
          } as const;
          assert.equal(
            await account.signTypedData(noDomain),
            await VIEM_ACCOUNT.signTypedData(noDomain),
          );
        });

        it("for transactions of types 0, 1, 2 and 4, and a contract creation", async () => {
          const { connection } = setup({ adapter: adapterOptions });
          const account = await createKmsNetworkConnection(connection).getAccount(ADDRESS);
          for (const transaction of [LEGACY, EIP2930, EIP1559, CREATION, await eip7702()]) {
            const signed = await account.signTransaction(transaction);
            assert.equal(signed, await VIEM_ACCOUNT.signTransaction(transaction));
            // With viem's own serializer passed, as viem's actions pass a chain's.
            assert.equal(
              await account.signTransaction(transaction, { serializer: serializeTransaction }),
              signed,
            );
          }
        });

        it("for authorizations, including chain 0 when allowed", async () => {
          const { connection } = setup({ adapter: adapterOptions });
          const kms = createKmsNetworkConnection(connection);
          const account = await kms.getAccount(ADDRESS);
          for (const request of [
            { contractAddress: DELEGATE, chainId: CHAIN_ID, nonce: 0 },
            { address: DELEGATE_LOWERCASE, chainId: CHAIN_ID, nonce: 41 },
          ] as const) {
            assert.deepEqual(
              await account.signAuthorization(request),
              await VIEM_ACCOUNT.signAuthorization(request),
            );
          }
          const anyChain = await kms.getAccount(ADDRESS, { allowChainZeroAuthorization: true });
          const request = { contractAddress: DELEGATE, chainId: 0, nonce: 5 } as const;
          assert.deepEqual(
            await anyChain.signAuthorization(request),
            await VIEM_ACCOUNT.signAuthorization(request),
          );
        });

        it("for bare digests with rawSign", async () => {
          const { connection } = setup({ adapter: adapterOptions });
          const warn = mock.method(console, "warn", () => undefined);
          const account = await createKmsNetworkConnection(connection).getAccount(ADDRESS, {
            rawSign: true,
          });
          assert.equal(warn.mock.callCount(), 1);
          const hash = `0x${"ab".repeat(32)}` as const;
          assert.equal(await account.sign({ hash }), await VIEM_ACCOUNT.sign({ hash }));
        });
      });
    }
  });

  describe("refuses before any KMS call", () => {
    it("a transaction for another chain, or with no chain", async () => {
      const { adapter, account: kms } = await setupAccount();
      await assertRefused(
        adapter,
        async () => await kms.signTransaction({ ...EIP1559, chainId: 1 }),
        /signTransaction: the transaction is for chain 1, but network local is chain 31337/,
      );
      const { chainId: _chainId, ...noChain } = EIP1559;
      await assertRefused(
        adapter,
        async () => await kms.signTransaction(noChain),
        /the transaction has no chainId/,
      );
    });

    it("a blob transaction (type 3), by type or by its fields", async () => {
      const { adapter, account: kms } = await setupAccount();
      await assertRefused(
        adapter,
        async () => await kms.signTransaction({ ...EIP1559, type: "eip4844" }),
        /blob transactions \(EIP-4844\) cannot be signed/,
      );
      for (const field of ["blobs", "blobVersionedHashes", "maxFeePerBlobGas", "sidecars"]) {
        await assertRefused(
          adapter,
          async () => await kms.signTransaction({ ...EIP1559, [field]: [] }),
          /blob transactions/,
        );
      }
    });

    it("another transaction type, or one that cannot be told", async () => {
      const { adapter, account: kms } = await setupAccount();
      await assertRefused(
        adapter,
        async () => await kms.signTransaction({ ...EIP1559, type: "deposit" }),
        /transaction type deposit is not signed/,
      );
      await assertRefused(
        adapter,
        async () => await kms.signTransaction({ chainId: CHAIN_ID, to: TO, gas: 21_000n }),
        /type cannot be told/,
      );
      await assertRefused(
        adapter,
        async () => await kms.signTransaction({ ...EIP1559, to: undefined }),
        /contract creation \(no `to`\) needs `data`/,
      );
    });

    it("a serializer whose bytes differ, or that throws", async () => {
      const { adapter, account: kms } = await setupAccount();
      await assertRefused(
        adapter,
        async () =>
          await kms.signTransaction(EIP1559, {
            serializer: () => serializeTransaction({ ...EIP1559, nonce: 99 }),
          }),
        /the serializer encodes the transaction differently from hardhat-kms, so it was not signed/,
      );
      await assertRefused(
        adapter,
        async () =>
          await kms.signTransaction(EIP1559, {
            serializer: () => {
              throw new TypeError("no");
            },
          }),
        /the serializer failed on the transaction \(TypeError\)/,
      );
      await assertRefused(
        adapter,
        async () => await kms.signTransaction(EIP1559, { serializer: async () => 42 }),
        /encodes the transaction differently/,
      );
    });

    it("a transaction viem's own serializer refuses", async () => {
      // viem refuses EIP-1559 fees on an EIP-2930 transaction; the plugin's encoder ignores them.
      const { adapter, account: kms } = await setupAccount();
      await assertRefused(
        adapter,
        async () => await untyped(kms.signTransaction, { ...EIP2930, maxFeePerGas: 1n }),
        /viem's serializeTransaction failed on the transaction/,
      );
    });

    it("an authorization for chain 0 without the option, or for another chain", async () => {
      const { adapter, account: kms, chainCalls } = await setupAccount();
      await assertRefused(
        adapter,
        async () =>
          await kms.signAuthorization({ contractAddress: DELEGATE, chainId: 0, nonce: 0 }),
        /an authorization for chain 0 is valid on every chain .* Pass `allowChainZeroAuthorization: true`/,
      );
      assert.equal(chainCalls.count, 0, "chain 0 is refused without asking the node");
      await assertRefused(
        adapter,
        async () =>
          await kms.signAuthorization({ contractAddress: DELEGATE, chainId: 1, nonce: 0 }),
        /the authorization is for chain 1, but network local is chain 31337/,
      );
    });

    it("typed data for another chain, unless kms.allowCrossChainTypedData is set", async () => {
      const { adapter, account: kms } = await setupAccount();
      await assertRefused(
        adapter,
        async () => await kms.signTypedData(EIP712_MAIL),
        /the typed data is for chain 1, but network local is chain 31337/,
      );
      const allowed = await setupAccount({ allowCrossChainTypedData: true });
      const cow = privateKeyToAccount(`0x${HARDHAT_ACCOUNT_0.secretKey}`);
      assert.equal(
        await allowed.account.signTypedData(EIP712_MAIL),
        await untyped(cow.signTypedData, EIP712_MAIL),
      );
    });

    it("values viem would not pass", async () => {
      const { adapter, account: kms } = await setupAccount();
      const refusals: [() => Promise<unknown>, RegExp][] = [
        [
          async () => await untyped(kms.signMessage, { message: { raw: "0xabc" } }),
          /message must be/,
        ],
        [async () => await untyped(kms.signMessage, {}), /message must be/],
        [
          async () => await kms.signTypedData({ ...TYPED_DATA, primaryType: "EIP712Domain" }),
          /primaryType must be a type of `types`, not EIP712Domain/,
        ],
        [async () => await untyped(kms.signTypedData, null), /typed data must be an object/],
        [
          async () => await kms.signTypedData({ ...TYPED_DATA, primaryType: "Missing" }),
          /typed data/,
        ],
        [async () => await untyped(kms.signTransaction, null), /the transaction must be an object/],
        [
          async () => await kms.signTransaction({ ...EIP1559, nonce: -1 }),
          /transaction\.nonce must be a non-negative integer/,
        ],
        [
          async () => await untyped(kms.signTransaction, { ...EIP1559, to: "0x1234" }),
          /transaction\.to must be an address/,
        ],
        [
          async () => await untyped(kms.signTransaction, { ...EIP1559, data: "0x123" }),
          /transaction\.data must be 0x-prefixed hex bytes/,
        ],
        [
          async () =>
            await kms.signTransaction({
              ...EIP2930,
              accessList: [{ address: TO, storageKeys: ["0x01"] }],
            }),
          /storageKeys\[0\] must be 32 bytes of hex/,
        ],
        [
          async () => await untyped(kms.signTransaction, { ...EIP2930, accessList: {} }),
          /accessList must be an array/,
        ],
        [
          async () =>
            await untyped(kms.signTransaction, { ...EIP2930, accessList: [{ address: TO }] }),
          /accessList\[0\] must be an object with address and storageKeys/,
        ],
        [
          async () =>
            await untyped(kms.signTransaction, { ...(await eip7702()), authorizationList: {} }),
          /authorizationList must be an array/,
        ],
        [
          async () =>
            await untyped(kms.signTransaction, { ...(await eip7702()), authorizationList: [1] }),
          /authorizationList\[0\] must be a signed authorization/,
        ],
        [
          async () => {
            const entry = await signedAuthorization();
            return await untyped(kms.signTransaction, {
              ...EIP7702_FIELDS,
              authorizationList: [{ ...entry, yParity: 2 }],
            });
          },
          /yParity must be 0 or 1, or v as 27n or 28n/,
        ],
        [
          async () => {
            const entry = await signedAuthorization();
            return await kms.signTransaction({
              ...EIP7702_FIELDS,
              authorizationList: [{ ...entry, r: `0x${"11".repeat(33)}` }],
            });
          },
          /r must be at most 32 bytes of hex/,
        ],
        [
          async () => await kms.signTransaction({ ...EIP1559, gas: 2n ** 300n }),
          /the transaction cannot be encoded/,
        ],
        [
          async () =>
            await kms.signAuthorization({
              contractAddress: DELEGATE,
              chainId: CHAIN_ID,
              nonce: 1.5,
            }),
          /nonce must be a non-negative integer, as a number/,
        ],
        [
          async () =>
            await kms.signAuthorization({
              contractAddress: "0x12",
              chainId: CHAIN_ID,
              nonce: 0,
            }),
          /address must be an address/,
        ],
        [
          async () => await untyped(kms.signAuthorization, undefined),
          /authorization must be an object/,
        ],
      ];
      for (const [run, message] of refusals) {
        await assertRefused(adapter, run, message);
      }
    });
  });

  it("keeps a string domain.chainId in the digest, which viem drops", async () => {
    // viem's hashTypedData leaves a string chainId out of the domain; the plugin encodes it as the
    // uint256 a contract's domain separator holds, as for a number.
    const { account: kms } = await setupAccount();
    const asString = { ...TYPED_DATA, domain: { ...TYPED_DATA.domain, chainId: String(CHAIN_ID) } };
    const signed = await untyped(kms.signTypedData, asString);
    assert.equal(signed, await VIEM_ACCOUNT.signTypedData(TYPED_DATA));
    const { chainId: _chainId, ...noChain } = TYPED_DATA.domain;
    assert.equal(
      await untyped(VIEM_ACCOUNT.signTypedData, asString),
      await VIEM_ACCOUNT.signTypedData({ ...TYPED_DATA, domain: noChain }),
    );
  });

  it("reads authorization yParity from v, as viem does", async () => {
    const { connection } = setup();
    const kms = await createKmsNetworkConnection(connection).getAccount(ADDRESS);
    const { address, chainId, nonce, r, s, yParity } = await signedAuthorization();
    const viaV: TransactionSerializable = {
      ...EIP7702_FIELDS,
      authorizationList: [{ address, chainId, nonce, r, s, v: yParity === 1 ? 28n : 27n }],
    };
    assert.equal(await kms.signTransaction(viaV), await VIEM_ACCOUNT.signTransaction(viaV));
  });

  it("has no sign without rawSign, and exposes no signer or key material", async () => {
    const { connection } = setup();
    const kms = createKmsNetworkConnection(connection);
    const account = await kms.getAccount(ADDRESS);
    assert.equal("sign" in account, false);
    assert.ok(Object.isFrozen(account));
    assert.ok(Object.isFrozen(kms));
    assert.deepEqual(Object.keys(account).toSorted(), [
      "address",
      "publicKey",
      "signAuthorization",
      "signMessage",
      "signTransaction",
      "signTypedData",
      "source",
      "type",
    ]);
    for (const name of Object.keys(account)) {
      const value: unknown = Reflect.get(account, name);
      assert.ok(
        typeof value === "string" || typeof value === "function",
        `${name} is a string or a function`,
      );
    }
    const raw = await kms.getAccount(ADDRESS, { rawSign: true });
    assert.equal(typeof raw.sign, "function");
    assert.ok(!JSON.stringify(raw).includes(HARDHAT_ACCOUNT_0.secretKey));
  });

  describe("getAccount refuses", () => {
    it("when viem cannot be loaded, naming the package, before any KMS call", async () => {
      const { adapter, connection } = setup();
      await assertRefused(
        adapter,
        async () => await createKmsNetworkConnection(connection, missingViem).getAccount(ADDRESS),
        /getAccount: connection\.kms\.getAccount needs the viem package, which could not be loaded \(Error, ERR_MODULE_NOT_FOUND\)\. Install it with `npm install --save-dev viem`/,
      );
    });

    it("names the load error's code only when it is a Node.js error code", async () => {
      const { adapter, connection } = setup();
      for (const [code, reason] of [
        [undefined, "TypeError"],
        ["ERR_UNSUPPORTED_DIR_IMPORT", "TypeError, ERR_UNSUPPORTED_DIR_IMPORT"],
        ["err_lower", "TypeError"],
        ["X".repeat(64), `TypeError, ${"X".repeat(64)}`],
        ["X".repeat(65), "TypeError"],
        ["E1", "TypeError, E1"],
        ["1E", "TypeError"],
        [" ERR_SPACE", "TypeError"],
        ["ERR_SPACE ", "TypeError"],
        [7, "TypeError"],
      ] as const) {
        const before = kmsCalls(adapter);
        await assert.rejects(
          async () =>
            await createKmsNetworkConnection(connection, failingViem(code)).getAccount(ADDRESS),
          (error: unknown) => {
            assert.ok(error instanceof HardhatPluginError);
            assert.equal(error.message, viemMissingMessage(reason));
            return true;
          },
        );
        assert.equal(kmsCalls(adapter), before);
      }
    });

    it("an address that is not a KMS account, listing the KMS addresses", async () => {
      const { adapter, connection } = setup();
      await assertRefused(
        adapter,
        async () => await createKmsNetworkConnection(connection).getAccount(TO),
        new RegExp(`${TO} is not a KMS account of network local\\. .*${ADDRESS}`),
      );
      const empty: AccountConnection = {
        ...connection,
        accounts: { ...connection.accounts, addresses: async () => await Promise.resolve([]) },
      };
      await assertRefused(
        adapter,
        async () => await createKmsNetworkConnection(empty).getAccount(TO),
        /is not a KMS account of network local\. It has no KMS accounts\./,
      );
    });

    it("an invalid address or options", async () => {
      const { adapter, connection } = setup();
      const kms = createKmsNetworkConnection(connection);
      const refusals: [() => Promise<unknown>, RegExp][] = [
        [async () => await kms.getAccount("0x1234"), /address must be an address/],
        [
          async () => await untyped(kms.getAccount, ADDRESS, { rawsign: true }),
          /rawsign is not an option of getAccount/,
        ],
        [async () => await untyped(kms.getAccount, ADDRESS, "yes"), /options must be an object/],
        [
          async () => await untyped(kms.getAccount, ADDRESS, { rawSign: 1 }),
          /options\.rawSign must be a boolean/,
        ],
      ];
      for (const [run, message] of refusals) {
        await assertRefused(adapter, run, message);
      }
    });
  });

  describe("reads only the options object's own properties", () => {
    it("ignores options inherited from a prototype", async () => {
      const { adapter, connection } = setup();
      const kms = createKmsNetworkConnection(connection);
      const warn = mock.method(console, "warn", () => undefined);
      // The options only inherit their flags, as Object.create({ rawSign: true }) would.
      const inheritsRawSign: KmsAccountOptions = {};
      Object.setPrototypeOf(inheritsRawSign, { rawSign: true });
      const inherited = await kms.getAccount(ADDRESS, inheritsRawSign);
      assert.equal("sign" in inherited, false);
      const inheritsChainZero: KmsAccountOptions = {};
      Object.setPrototypeOf(inheritsChainZero, { allowChainZeroAuthorization: true });
      const chainZero = await kms.getAccount(ADDRESS, inheritsChainZero);
      await assertRefused(
        adapter,
        async () =>
          await chainZero.signAuthorization({ contractAddress: DELEGATE, chainId: 0, nonce: 0 }),
        /an authorization for chain 0 is valid on every chain/,
      );
      assert.equal(warn.mock.callCount(), 0, "no rawSign warning");
    });

    it("ignores a polluted Object.prototype", async () => {
      const { adapter, connection } = setup();
      const kms = createKmsNetworkConnection(connection);
      const warn = mock.method(console, "warn", () => undefined);
      // As a prototype-pollution bug sets them: plain, enumerable assignments.
      Reflect.set(Object.prototype, "rawSign", true);
      Reflect.set(Object.prototype, "allowChainZeroAuthorization", true);
      try {
        for (const options of [{}, undefined]) {
          const account = await kms.getAccount(ADDRESS, options);
          assert.equal(Object.hasOwn(account, "sign"), false);
          await assertRefused(
            adapter,
            async () =>
              await account.signAuthorization({ contractAddress: DELEGATE, chainId: 0, nonce: 0 }),
            /an authorization for chain 0 is valid on every chain/,
          );
        }
      } finally {
        Reflect.deleteProperty(Object.prototype, "rawSign");
        Reflect.deleteProperty(Object.prototype, "allowChainZeroAuthorization");
      }
      assert.equal(warn.mock.callCount(), 0, "no rawSign warning");
    });
  });

  describe("refuses once the connection is closed, before any KMS call", () => {
    it("when the connection closes during a call, before its KMS call", async () => {
      // The close lands while the call waits for the chain id, after its first check.
      const { adapter, connection, state } = setup();
      const closing: AccountConnection = {
        ...connection,
        chainId: async () => {
          state.closed = true;
          return await connection.chainId();
        },
      };
      const account = await createKmsNetworkConnection(closing).getAccount(ADDRESS);
      await assertClosed(
        adapter,
        "signTransaction",
        async () => await account.signTransaction(EIP1559),
      );
      state.closed = false;
      await assertClosed(
        adapter,
        "signAuthorization",
        async () =>
          await account.signAuthorization({
            contractAddress: DELEGATE,
            chainId: CHAIN_ID,
            nonce: 0,
          }),
      );
      state.closed = false;
      await assertClosed(
        adapter,
        "signTypedData",
        async () => await account.signTypedData(TYPED_DATA),
      );
      assert.equal(adapter.calls.signDigest, 0, "no KMS signature");
    });

    it("every method of the account, and getAccount", async () => {
      const { adapter, connection, chainCalls, state } = setup();
      const kms = createKmsNetworkConnection(connection);
      const warn = mock.method(console, "warn", () => undefined);
      const account = await kms.getAccount(ADDRESS, { rawSign: true });
      state.closed = true;
      const chainBefore = chainCalls.count;
      await assertClosed(adapter, "getAccount", async () => await kms.getAccount(ADDRESS));
      // getAccount refuses before loading viem or looking the key up, which can call the KMS.
      let lookups = 0;
      const counting: AccountConnection = {
        ...connection,
        accounts: {
          ...connection.accounts,
          keyFor: async (address) => {
            lookups++;
            return await connection.accounts.keyFor(address);
          },
        },
      };
      let loads = 0;
      const countingLoad: LoadViem = async () => {
        loads++;
        return await loadViem();
      };
      await assertClosed(
        adapter,
        "getAccount",
        async () => await createKmsNetworkConnection(counting, countingLoad).getAccount(ADDRESS),
      );
      assert.deepEqual({ lookups, loads }, { lookups: 0, loads: 0 });
      await assertClosed(
        adapter,
        "signMessage",
        async () => await account.signMessage({ message: "hello" }),
      );
      await assertClosed(
        adapter,
        "signTypedData",
        async () => await account.signTypedData(TYPED_DATA),
      );
      await assertClosed(
        adapter,
        "signTransaction",
        async () => await account.signTransaction(EIP1559),
      );
      await assertClosed(
        adapter,
        "signAuthorization",
        async () =>
          await account.signAuthorization({
            contractAddress: DELEGATE,
            chainId: CHAIN_ID,
            nonce: 0,
          }),
      );
      await assertClosed(
        adapter,
        "sign",
        async () => await account.sign({ hash: `0x${"ab".repeat(32)}` }),
      );
      assert.equal(chainCalls.count, chainBefore, "nor ask the node for its chain");
      assert.equal(warn.mock.callCount(), 1, "only getAccount's rawSign warning");
    });
  });

  it("loads viem's serializer from the project", async () => {
    const { serializeTransaction: loaded } = await loadViem();
    assert.equal(loaded(EIP1559), serializeTransaction(EIP1559));
  });
});
