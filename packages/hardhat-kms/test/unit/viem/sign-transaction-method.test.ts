// A library account over an adapter with `signTransaction` (#514): transactions go to it with the
// core's unsigned bytes, the result is the same as viem's own account, and a hostile adapter is
// refused before the transaction is returned or its nonce noted.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { keccak_256 } from "@noble/hashes/sha3.js";
import { HardhatPluginError } from "hardhat/plugins";
import { serializeTransaction, type TransactionSerializable } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ERRORS } from "../../../src/internal/error-catalog.ts";
import { catalogError, catalogMessage } from "../../../src/internal/errors.ts";
import { createKmsNetworkConnection } from "../../../src/internal/viem/account.ts";
import { fakeTxAdapter, type TxBehaviour } from "../../helpers/fake-tx-adapter.ts";
import {
  ADDRESS,
  CHAIN_ID,
  setup,
  VIEM_ACCOUNT,
  viemAuthorizationWithoutV,
} from "../../helpers/library-account.ts";
import { COW_ACCOUNT, HARDHAT_ACCOUNT_0 } from "../../helpers/vectors.ts";

const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const secretKey = hex(HARDHAT_ACCOUNT_0.secretKey);
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DELEGATE = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const AUTHORITY = privateKeyToAccount(`0x${COW_ACCOUNT.secretKey}`);

const common = { chainId: CHAIN_ID, nonce: 7, gas: 60_000n, to: TO, value: 3n } as const;

/** One transaction of each type the plugin signs, with its EIP-2718 type number. */
async function transactions(): Promise<Array<[number, TransactionSerializable]>> {
  return [
    [0, { ...common, type: "legacy", gasPrice: 5n }],
    [1, { ...common, type: "eip2930", gasPrice: 5n, accessList: [] }],
    [2, { ...common, type: "eip1559", maxFeePerGas: 5n, maxPriorityFeePerGas: 1n }],
    [
      4,
      {
        ...common,
        type: "eip7702",
        maxFeePerGas: 5n,
        maxPriorityFeePerGas: 1n,
        authorizationList: [
          await AUTHORITY.signAuthorization({
            contractAddress: DELEGATE,
            chainId: CHAIN_ID,
            nonce: 0,
          }),
        ],
      },
    ],
  ];
}

/** A library account whose signer uses a fake adapter with `signTransaction`. */
async function txAccount(behaviour: TxBehaviour = "honest") {
  const adapter = fakeTxAdapter({
    secretKey,
    behaviour,
    otherSecretKey: hex(COW_ACCOUNT.secretKey),
  });
  const context = setup({ signWithAdapter: adapter });
  const account = await createKmsNetworkConnection(context.connection).getAccount(ADDRESS);
  return { ...context, txAdapter: adapter, account };
}

describe("a library account over an adapter with signTransaction", () => {
  it("signs every transaction type through it, with viem's bytes", async () => {
    for (const [type, transaction] of await transactions()) {
      const { account, txAdapter, nonceCalls } = await txAccount();

      assert.equal(
        await account.signTransaction(transaction),
        await VIEM_ACCOUNT.signTransaction(transaction),
      );
      const unsigned = hex(serializeTransaction(transaction).slice(2));
      assert.deepEqual(txAdapter.transactions, [
        { unsigned, digest: keccak_256(unsigned), type, chainId: BigInt(CHAIN_ID) },
      ]);
      assert.equal(txAdapter.calls.signDigest, 0);
      assert.deepEqual(nonceCalls, [["signed", ADDRESS.toLowerCase(), 7n]]);
    }
  });

  const noRecovery = catalogMessage(ERRORS.signatureNoRecovery, {});
  for (const [behaviour, reason] of [
    ["otherBody", noRecovery],
    ["otherKey", noRecovery],
    ["malformed", catalogMessage(ERRORS.signatureRange, {})],
  ] as const) {
    it(`refuses ${behaviour} for every type, and notes no nonce`, async () => {
      for (const [, transaction] of await transactions()) {
        const { account, txAdapter, nonceCalls } = await txAccount(behaviour);

        await assert.rejects(account.signTransaction(transaction), (error: unknown) => {
          assert.ok(error instanceof HardhatPluginError, String(error));
          assert.equal(
            error.message,
            catalogError(
              ERRORS.signerInvalidSignature,
              { reason },
              { provider: "fake", operation: "sign", key: "fake-key-1" },
            ).message,
          );
          return true;
        });
        assert.equal(txAdapter.calls.signTransaction, 2);
        assert.equal(txAdapter.calls.signDigest, 0);
        assert.deepEqual(nonceCalls, []);
      }
    });
  }

  it("signs messages with signMessage and authorizations with signDigest", async () => {
    const { account, txAdapter } = await txAccount();
    const request = { contractAddress: DELEGATE, chainId: CHAIN_ID, nonce: 1 } as const;

    assert.equal(
      await account.signMessage({ message: "hello" }),
      await VIEM_ACCOUNT.signMessage({ message: "hello" }),
    );
    assert.deepEqual(
      await account.signAuthorization(request),
      await viemAuthorizationWithoutV(request),
    );
    assert.deepEqual(txAdapter.calls, { signDigest: 1, signMessage: 1, signTransaction: 0 });
  });
});
