// Every refusal of a library account, with its exact message, so that the method name, the field
// path and the reason in each message are checked. Next to them, the transactions whose fields are
// read the way viem reads them (an inferred type, a recovery bit from `v`, empty values) must give
// viem's bytes. Every refusal must come before any KMS call.
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { HardhatPluginError } from "hardhat/plugins";
import { privateKeyToAccount } from "viem/accounts";

import { createKmsNetworkConnection, type LoadViem } from "../../../src/internal/viem/account.ts";
import {
  ADDRESS,
  assertRefused,
  CHAIN_ID,
  kmsCalls,
  setup,
  VIEM_ACCOUNT,
  viemAuthorizationWithoutV,
} from "../../helpers/library-account.ts";
import { COW_ACCOUNT } from "../../helpers/vectors.ts";

const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DELEGATE = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const COW = privateKeyToAccount(`0x${COW_ACCOUNT.secretKey}`);
const ADDRESS_FORM =
  "an address: 0x and 40 hex digits, with a valid EIP-55 checksum if it is mixed-case";
const QUANTITY = "a non-negative integer, as a number or a bigint";

const EIP1559 = {
  type: "eip1559",
  chainId: CHAIN_ID,
  nonce: 0,
  gas: 21_000n,
  maxFeePerGas: 3n,
  maxPriorityFeePerGas: 1n,
  to: TO,
  value: 1n,
} as const;

const EIP7702 = {
  type: "eip7702",
  chainId: CHAIN_ID,
  maxFeePerGas: 2n,
  maxPriorityFeePerGas: 1n,
  to: TO,
} as const;

/** An authorization from another key, with a nonce other than 0 so that its nonce is checked. */
const AUTHORIZATION = await COW.signAuthorization({ address: TO, chainId: CHAIN_ID, nonce: 5 });

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

/** An account with `sign`, and its adapter. */
async function rawAccount() {
  const { adapter, connection } = setup();
  const warn = mock.method(console, "warn", () => undefined);
  try {
    const account = await createKmsNetworkConnection(connection).getAccount(ADDRESS, {
      rawSign: true,
    });
    return { adapter, account };
  } finally {
    warn.mock.restore();
  }
}

/** The message of a refused field of a transaction. */
const field = (path: string, expected: string): string =>
  `signTransaction: ${path} must be ${expected}`;

/** An EIP-7702 transaction whose authorization has the given fields changed. */
const authorization = (entry: Record<string, unknown>): Record<string, unknown> => ({
  ...EIP7702,
  authorizationList: [{ ...AUTHORIZATION, ...entry }],
});

/** A loader that fails with an error whose `code` is the given value. */
const failingViem =
  (code: unknown): LoadViem =>
  async () => {
    throw await Promise.resolve(Object.assign(new TypeError("no"), { code }));
  };

/** Signs with the account and with viem, and asserts the same bytes. */
async function assertSameAsViem(
  transactions: Record<string, Record<string, unknown>>,
): Promise<void> {
  const { adapter, account } = await rawAccount();
  for (const [name, transaction] of Object.entries(transactions)) {
    const before = kmsCalls(adapter);
    assert.equal(
      await account.signTransaction(transaction),
      await VIEM_ACCOUNT.signTransaction(transaction),
      name,
    );
    assert.equal(kmsCalls(adapter), before + 1, `${name}: one KMS call`);
  }
}

/** A transaction field the account refuses, and the message. */
type Refusal = [string, Record<string, unknown> | null, string];

describe("a library account refuses, with the exact message", () => {
  it("transactions", async () => {
    const { adapter, account } = await rawAccount();
    const refusals: Refusal[] = [
      ["not an object", null, "signTransaction: the transaction must be an object"],
      [
        "blob fields",
        { ...EIP1559, maxFeePerBlobGas: 1n },
        "signTransaction: blob transactions (EIP-4844) cannot be signed with KMS accounts; send them from another account",
      ],
      [
        "a numeric type",
        { ...EIP1559, type: 2 },
        "signTransaction: transaction type number is not signed: KMS accounts sign legacy, eip2930, eip1559 and eip7702 transactions",
      ],
      [
        "a long type, cut to 32 characters",
        { ...EIP1559, type: "x".repeat(40) },
        `signTransaction: transaction type ${"x".repeat(32)} is not signed: KMS accounts sign legacy, eip2930, eip1559 and eip7702 transactions`,
      ],
      [
        "no type and no fee",
        { chainId: CHAIN_ID, to: TO },
        "signTransaction: the transaction's type cannot be told from its fields: set type, gasPrice or maxFeePerGas",
      ],
      [
        "no chain",
        { ...EIP1559, chainId: undefined },
        "signTransaction: the transaction has no chainId; a KMS account signs only for its network's chain",
      ],
      ["a negative chain", { ...EIP1559, chainId: -1 }, field("transaction.chainId", QUANTITY)],
      ["a negative bigint", { ...EIP1559, nonce: -1n }, field("transaction.nonce", QUANTITY)],
      ["a fraction", { ...EIP1559, nonce: 1.5 }, field("transaction.nonce", QUANTITY)],
      ["a string quantity", { ...EIP1559, nonce: "1" }, field("transaction.nonce", QUANTITY)],
      [
        "a creation without data",
        { ...EIP1559, to: null },
        "signTransaction: a contract creation (no `to`) needs `data`",
      ],
      [
        "a String object as `to`",
        { ...EIP1559, to: Object(TO) },
        field("transaction.to", ADDRESS_FORM),
      ],
      [
        "data in an array",
        { ...EIP1559, data: ["0xab"] },
        field("transaction.data", "0x-prefixed hex bytes"),
      ],
      [
        "data with text before 0x",
        { ...EIP1559, data: "00x12" },
        field("transaction.data", "0x-prefixed hex bytes"),
      ],
      [
        "an access-list address",
        { ...EIP1559, accessList: [{ address: "0x12", storageKeys: [] }] },
        field("transaction.accessList[0].address", ADDRESS_FORM),
      ],
      [
        "a storage key that is not hex",
        { ...EIP1559, accessList: [{ address: TO, storageKeys: ["zz"] }] },
        field("transaction.accessList[0].storageKeys[0]", "0x-prefixed hex bytes"),
      ],
      [
        "an authorization's chain",
        authorization({ chainId: -1 }),
        field("transaction.authorizationList[0].chainId", QUANTITY),
      ],
      [
        "an authorization's address",
        authorization({ address: "0x1" }),
        field("transaction.authorizationList[0].address", ADDRESS_FORM),
      ],
      [
        "an authorization's nonce",
        authorization({ nonce: -1 }),
        field("transaction.authorizationList[0].nonce", QUANTITY),
      ],
      [
        "an authorization's r",
        authorization({ r: "zz" }),
        field("transaction.authorizationList[0].r", "0x-prefixed hex bytes"),
      ],
      [
        "an authorization whose yParity is out of range, whatever v is",
        authorization({ yParity: 2, v: 27n }),
        field("transaction.authorizationList[0].yParity", "0 or 1, or v as 27n or 28n"),
      ],
      [
        "an authorization without yParity or v",
        authorization({ yParity: undefined, v: undefined }),
        field("transaction.authorizationList[0].yParity", "0 or 1, or v as 27n or 28n"),
      ],
      [
        "a value the encoder refuses",
        { ...EIP1559, gas: 2n ** 300n },
        "signTransaction: the transaction cannot be encoded: fields had validation errors",
      ],
      [
        "only a priority fee, above the zero fee cap",
        { ...EIP1559, type: undefined, maxFeePerGas: undefined },
        "signTransaction: the transaction cannot be encoded: fields had validation errors",
      ],
      [
        "another chain",
        { ...EIP1559, chainId: 1 },
        "signTransaction: the transaction is for chain 1, but network local is chain 31337",
      ],
    ];
    for (const [name, transaction, message] of refusals) {
      await assertRefused(
        adapter,
        async () => await untyped(account.signTransaction, transaction),
        message,
      ).catch((error: unknown) => {
        throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  });

  it("transactions a serializer encodes differently, or fails on", async () => {
    const { adapter, account } = await rawAccount();
    await assertRefused(
      adapter,
      async () => await account.signTransaction(EIP1559, { serializer: () => "0x00" }),
      "signTransaction: the serializer encodes the transaction differently from hardhat-kms, so it was not signed",
    );
    await assertRefused(
      adapter,
      async () =>
        await account.signTransaction(EIP1559, {
          serializer: () => {
            throw new RangeError("no");
          },
        }),
      "signTransaction: the serializer failed on the transaction (RangeError), so it was not signed",
    );
  });

  it("messages, digests, typed data and authorizations", async () => {
    const { adapter, account } = await rawAccount();
    const message =
      "signMessage: message must be a string, or { raw } with 0x-prefixed hex bytes or a Uint8Array";
    for (const parameters of [{}, { message: { raw: ["0xab"] } }, { message: { raw: "0xabc" } }]) {
      await assertRefused(
        adapter,
        async () => await untyped(account.signMessage, parameters),
        message,
      );
    }
    const hash = "sign: hash must be 32 bytes as 0x-prefixed hex";
    for (const parameters of [
      {},
      { hash: `0x${"ab".repeat(33)}` },
      { hash: `zz0x${"ab".repeat(32)}` },
      { hash: [`0x${"ab".repeat(32)}`] },
    ]) {
      await assertRefused(adapter, async () => await untyped(account.sign, parameters), hash);
    }
    await assertRefused(
      adapter,
      async () => await account.signTypedData({ types: {}, primaryType: "EIP712Domain" }),
      "signTypedData: primaryType must be a type of `types`, not EIP712Domain",
    );
    const authorizations: [Record<string, unknown>, string][] = [
      [
        { address: TO, chainId: 1.5, nonce: 0 },
        "signAuthorization: chainId must be a non-negative integer, as a number",
      ],
      [
        { address: TO, chainId: -1, nonce: 0 },
        "signAuthorization: chainId must be a non-negative integer, as a number",
      ],
      [
        { address: TO, chainId: CHAIN_ID, nonce: "1" },
        "signAuthorization: nonce must be a non-negative integer, as a number",
      ],
      [
        { address: 5, chainId: CHAIN_ID, nonce: 0 },
        `signAuthorization: address must be ${ADDRESS_FORM}`,
      ],
      [
        { address: TO, chainId: 0, nonce: 0 },
        "signAuthorization: an authorization for chain 0 is valid on every chain where the account's nonce matches. Pass `allowChainZeroAuthorization: true` to getAccount to sign it",
      ],
      [
        { address: TO, chainId: 1, nonce: 0 },
        "signAuthorization: the authorization is for chain 1, but network local is chain 31337",
      ],
    ];
    for (const [parameters, text] of authorizations) {
      await assertRefused(
        adapter,
        async () => await untyped(account.signAuthorization, parameters),
        text,
      );
    }
  });

  it("getAccount's options and addresses", async () => {
    const { adapter, connection } = setup();
    const kms = createKmsNetworkConnection(connection);
    const refusals: [unknown, string][] = [
      ["yes", "getAccount: options must be an object"],
      [
        { ["k".repeat(100)]: true },
        `getAccount: ${"k".repeat(64)} is not an option of getAccount; the options are rawSign, allowChainZeroAuthorization and signal`,
      ],
      [{ rawSign: 1 }, "getAccount: options.rawSign must be a boolean"],
      [
        { allowChainZeroAuthorization: "yes" },
        "getAccount: options.allowChainZeroAuthorization must be a boolean",
      ],
      [{ signal: "abort" }, "getAccount: options.signal must be an AbortSignal"],
      [{ signal: null }, "getAccount: options.signal must be an AbortSignal"],
      [{ signal: new AbortController() }, "getAccount: options.signal must be an AbortSignal"],
    ];
    for (const [options, message] of refusals) {
      await assertRefused(
        adapter,
        async () => await untyped(kms.getAccount, ADDRESS, options),
        message,
      );
    }
    await assertRefused(
      adapter,
      async () => await kms.getAccount(TO),
      `getAccount: ${TO} is not a KMS account of network local. The KMS account on this network is ${ADDRESS}.`,
    );
    await assertRefused(
      adapter,
      async () => await untyped(kms.getAccount, Object(ADDRESS)),
      `getAccount: address must be ${ADDRESS_FORM}`,
    );
  });

  it("an authorization whose signature does not recover to the account", async () => {
    // The signer is reached through the connection's signWith, a seam: here it signs with
    // another key than the account's address.
    const { connection } = setup({
      adapter: { secretKey: new Uint8Array(Buffer.from(COW_ACCOUNT.secretKey, "hex")) },
    });
    const account = await createKmsNetworkConnection(connection).getAccount(ADDRESS);
    await assert.rejects(
      async () => await account.signAuthorization({ address: TO, chainId: CHAIN_ID, nonce: 0 }),
      (error: unknown) =>
        error instanceof HardhatPluginError &&
        error.message ===
          "signAuthorization: the authorization does not recover to the account's address",
    );
  });

  it("names a load error's code only when it is a string in Node.js form", async () => {
    const { adapter, connection } = setup();
    await assertRefused(
      adapter,
      async () =>
        await createKmsNetworkConnection(connection, failingViem(["ERR_ARRAY"])).getAccount(
          ADDRESS,
        ),
      "getAccount: connection.kms.getAccount needs the viem package, which could not be loaded (TypeError). Install viem in the project",
    );
  });
});

describe("a library account reads fields as viem does", () => {
  it("tells the type from the fields when there is no type", async () => {
    await assertSameAsViem({
      authorizationList: { ...EIP7702, type: undefined, authorizationList: [AUTHORIZATION] },
      maxFeePerGas: { ...EIP1559, type: undefined, maxPriorityFeePerGas: undefined },
      gasPrice: { chainId: CHAIN_ID, gasPrice: 2n, to: TO },
      accessList: { chainId: CHAIN_ID, gasPrice: 2n, to: TO, accessList: [] },
    });
  });

  it("reads an authorization's recovery bit from yParity, else from v", async () => {
    await assertSameAsViem({
      "v 0": authorization({ yParity: undefined, v: 0n }),
      "v 1": authorization({ yParity: undefined, v: 1n }),
      "v 27": authorization({ yParity: undefined, v: 27n }),
      "v 28": authorization({ yParity: undefined, v: 28n }),
      "yParity 1 over v 27": authorization({ yParity: 1, v: 27n }),
      "yParity 0 over v 28": authorization({ yParity: 0, v: 28n }),
      "an empty r": authorization({ r: "0x" }),
      "no chain": authorization({ chainId: undefined }),
    });
  });

  it("takes empty and large values, creations and the fields of other types", async () => {
    await assertSameAsViem({
      "a zero bigint": { ...EIP1559, value: 0n },
      "a nonce above micro-eth-signer's strict limit": { ...EIP1559, nonce: 200_000 },
      "upper-case data": { ...EIP1559, data: "0xABCDEF" },
      "a creation with to null": { ...EIP1559, to: null, data: "0x60" },
      "a creation without to": { ...EIP1559, to: undefined, data: "0x60" },
      "a legacy transaction with an access list it ignores": {
        type: "legacy",
        chainId: CHAIN_ID,
        gasPrice: 2n,
        to: TO,
        // A value of another type's field, which viem ignores for legacy.
        accessList: "ignored",
      },
    });
  });

  it("pads the r and s of an authorization to 32 bytes", async () => {
    const { account } = await rawAccount();
    // With Hardhat's first key, the authorization for nonce 259 has an s, and for nonce 686 an
    // r, below 2^248.
    for (const [nonce, word] of [
      [259, "s"],
      [686, "r"],
    ] as const) {
      const request = { address: DELEGATE, chainId: CHAIN_ID, nonce } as const;
      const expected = await viemAuthorizationWithoutV(request);
      assert.ok(expected[word].startsWith("0x00"));
      assert.deepEqual(await account.signAuthorization(request), expected);
    }
  });

  it("signs UTF-8 text as its bytes", async () => {
    const { account } = await rawAccount();
    for (const message of ["héllo", "😀"]) {
      assert.equal(
        await account.signMessage({ message }),
        await VIEM_ACCOUNT.signMessage({ message }),
      );
    }
  });

  it("warns, with the address, when rawSign is asked for", async () => {
    const { connection } = setup();
    const warn = mock.method(console, "warn", () => undefined);
    try {
      await createKmsNetworkConnection(connection).getAccount(ADDRESS, { rawSign: true });
      assert.deepEqual(
        warn.mock.calls.map((call) => call.arguments),
        [
          [
            `hardhat-kms: the account ${ADDRESS} signs any 32-byte digest with sign({ hash }), which can be a transaction or a permit for any chain. Use rawSign only for an owner that needs it, such as a Coinbase smart account.`,
          ],
        ],
      );
    } finally {
      warn.mock.restore();
    }
  });
});
