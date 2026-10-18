// The adapter's `signTransaction` (#514): the core hands it its own unsigned bytes and digest, and
// verifies what comes back against that digest and the key, so a provider cannot change what is
// signed or sent. Adapters without the method keep signing transactions through `signDigest`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { HardhatPluginError } from "hardhat/plugins";
import { authorization, Transaction } from "micro-eth-signer";

import { ERRORS } from "../../../src/internal/error-catalog.ts";
import { catalogError, catalogMessage } from "../../../src/internal/errors.ts";
import type {
  FilledTransaction,
  TransactionFiller,
} from "../../../src/internal/rpc/transaction-filler.ts";
import {
  assembleSignedTransaction,
  signTransaction,
  transactionToSign,
} from "../../../src/internal/rpc/transactions.ts";
import { KmsSigner } from "../../../src/internal/signer/kms-signer.ts";
import type { KmsKeyAdapter } from "../../../src/internal/signer/types.ts";
import { fakeAdapter } from "../../helpers/fake-adapter.ts";
import { fakeTxAdapter, otherBody, type TxBehaviour } from "../../helpers/fake-tx-adapter.ts";
import { COW_ACCOUNT, HARDHAT_ACCOUNT_0 } from "../../helpers/vectors.ts";

const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const secretKey = hex(HARDHAT_ACCOUNT_0.secretKey);
const FROM = HARDHAT_ACCOUNT_0.address;
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const CURVE_ORDER = secp256k1.Point.CURVE().n;
const options = { timeoutMs: 30_000, displayMessage: async () => {} };

const AUTHORIZATION = authorization.sign(
  { chainId: 31337n, address: TO, nonce: 0n },
  `0x${COW_ACCOUNT.secretKey}`,
);
const bytes32 = (value: bigint) => hex(value.toString(16).padStart(64, "0"));

const base = {
  from: hex(FROM.slice(2)),
  to: hex(TO.slice(2)),
  gas: 60_000n,
  nonce: 3n,
  chainId: 31337n,
  value: 5n,
  data: Uint8Array.of(0xde, 0xad),
};

/** A filled transaction of each type the plugin signs, with its EIP-2718 type number. */
const FILLED: ReadonlyArray<[number, string, FilledTransaction]> = [
  [0, "legacy", { ...base, gasPrice: 7n }],
  [1, "eip2930", { ...base, gasPrice: 7n, accessList: [{ address: base.to, storageKeys: [] }] }],
  [2, "eip1559", { ...base, maxFeePerGas: 9n, maxPriorityFeePerGas: 2n }],
  [
    4,
    "eip7702",
    {
      ...base,
      maxFeePerGas: 9n,
      maxPriorityFeePerGas: 2n,
      authorizationList: [
        {
          chainId: AUTHORIZATION.chainId,
          address: hex(TO.slice(2)),
          nonce: AUTHORIZATION.nonce,
          yParity: Uint8Array.of(AUTHORIZATION.yParity),
          r: bytes32(AUTHORIZATION.r),
          s: bytes32(AUTHORIZATION.s),
        },
      ],
    },
  ],
];

const fillerOf = (filled: FilledTransaction): TransactionFiller => ({
  fill: async () => await Promise.resolve(filled),
});

/** Signs `filled` through the RPC path, as eth_signTransaction and `kms sign-tx` do. */
async function signFilled(adapter: KmsKeyAdapter, filled: FilledTransaction) {
  return await signTransaction(new KmsSigner(adapter, options), {
    filler: fillerOf(filled),
    method: "eth_signTransaction",
    params: [{ from: FROM }],
    from: FROM.toLowerCase(),
  });
}

/** What Hardhat's local account signs for the same unsigned transaction. */
function expectedRaw(filled: FilledTransaction): { unsigned: Uint8Array; raw: string } {
  // Rebuilt independently of the code under test, from the same fields.
  const fields = {
    to: TO,
    nonce: filled.nonce,
    chainId: filled.chainId,
    value: filled.value ?? 0n,
    data: "0xdead",
    gasLimit: filled.gas,
  };
  let tx;
  if (filled.authorizationList !== undefined) {
    tx = Transaction.prepare(
      {
        type: "eip7702",
        ...fields,
        maxFeePerGas: 9n,
        maxPriorityFeePerGas: 2n,
        accessList: [],
        authorizationList: [{ ...AUTHORIZATION, address: TO }],
      },
      false,
    );
  } else if (filled.maxFeePerGas !== undefined) {
    tx = Transaction.prepare(
      { type: "eip1559", ...fields, maxFeePerGas: 9n, maxPriorityFeePerGas: 2n, accessList: [] },
      false,
    );
  } else if (filled.accessList !== undefined) {
    tx = Transaction.prepare(
      { type: "eip2930", ...fields, gasPrice: 7n, accessList: [{ address: TO, storageKeys: [] }] },
      false,
    );
  } else {
    tx = Transaction.prepare({ type: "legacy", ...fields, gasPrice: 7n }, false);
  }
  return { unsigned: tx.toBytes(false), raw: tx.signBy(secretKey, false).toHex(true) };
}

/** The message of the signer's error after the provider kept returning invalid signatures. */
const invalidSignature = (reason: string): string =>
  catalogError(
    ERRORS.signerInvalidSignature,
    { reason },
    { provider: "fake", operation: "sign", key: "fake-key-1" },
  ).message;

async function assertRefused(promise: Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HardhatPluginError, String(error));
    assert.equal(error.message, message);
    return true;
  });
}

describe("the adapter's signTransaction", () => {
  describe("with an adapter that has it", () => {
    for (const [type, name, filled] of FILLED) {
      it(`signs a type ${type} (${name}) transaction through it, never through signDigest`, async () => {
        const adapter = fakeTxAdapter({ secretKey });
        const expected = expectedRaw(filled);

        const signed = await signFilled(adapter, filled);

        assert.equal(signed.raw, expected.raw);
        assert.equal(signed.nonce, 3n);
        assert.equal(adapter.calls.signTransaction, 1);
        assert.equal(adapter.calls.signDigest, 0);
        assert.deepEqual(adapter.transactions, [
          {
            unsigned: expected.unsigned,
            digest: keccak_256(expected.unsigned),
            type,
            chainId: 31337n,
          },
        ]);
      });
    }

    it("works for an address-only key, which the first signature identifies", async () => {
      const adapter = fakeTxAdapter({ secretKey, identity: "address" });
      const [, , filled] = FILLED[2] ?? assert.fail();
      const kms = new KmsSigner(adapter, options);

      const signed = await signTransaction(kms, {
        filler: fillerOf(filled),
        method: "eth_sendTransaction",
        params: [{ from: FROM }],
        from: FROM.toLowerCase(),
      });

      assert.equal(signed.raw, expectedRaw(filled).raw);
      assert.deepEqual(await kms.getPublicKey(), secp256k1.getPublicKey(secretKey, false));
    });

    it("signs a transaction the provider returns a high-S signature for as the low-S one", async () => {
      for (const [, , filled] of FILLED) {
        const adapter = fakeTxAdapter({ secretKey, behaviour: "highS" });
        const signed = await signFilled(adapter, filled);
        assert.equal(signed.raw, expectedRaw(filled).raw);
        const { s } = Transaction.fromHex(signed.raw, false).raw;
        assert.ok(s !== undefined && s <= CURVE_ORDER / 2n);
      }
    });

    it("accepts an adapter that signs the digest it was given", async () => {
      const adapter = fakeTxAdapter({ secretKey, behaviour: "digestOnly" });
      const [, , filled] = FILLED[1] ?? assert.fail();
      assert.equal((await signFilled(adapter, filled)).raw, expectedRaw(filled).raw);
    });
  });

  describe("refuses a hostile adapter, after one fresh attempt through the same method", () => {
    const noRecovery = catalogMessage(ERRORS.signatureNoRecovery, {});
    const refusals: ReadonlyArray<[TxBehaviour, string, string]> = [
      ["otherBody", "a signature over another transaction", noRecovery],
      ["otherKey", "another key's signature", noRecovery],
      ["malformed", "an r out of range", catalogMessage(ERRORS.signatureRange, {})],
      ["overwrite", "a signature over the bytes it overwrote", noRecovery],
    ];
    for (const [behaviour, name, reason] of refusals) {
      it(`refuses ${name} for every type, and returns no transaction`, async () => {
        for (const [, , filled] of FILLED) {
          const adapter = fakeTxAdapter({
            secretKey,
            behaviour,
            otherSecretKey: hex(COW_ACCOUNT.secretKey),
          });

          await assertRefused(signFilled(adapter, filled), invalidSignature(reason));
          assert.equal(adapter.calls.signTransaction, 2);
          assert.equal(adapter.calls.signDigest, 0);
          // Both attempts got the core's bytes, fresh, whatever the first one did with them.
          const expected = expectedRaw(filled).unsigned;
          assert.deepEqual(
            adapter.transactions.map((request) => request.unsigned),
            [expected, expected],
          );
        }
      });
    }

    it("refuses a signature over another body even when its key matches the pin", async () => {
      const [, , filled] = FILLED[2] ?? assert.fail();
      const unsigned = expectedRaw(filled).unsigned;
      // The hostile body really is another transaction, signed by the right key.
      assert.notDeepEqual(otherBody(unsigned), unsigned);
      const kms = new KmsSigner(fakeTxAdapter({ secretKey, behaviour: "otherBody" }), {
        ...options,
        expectedAddress: FROM,
      });
      await assertRefused(
        kms.signTransaction({ unsigned, type: 2, chainId: 31337n }),
        invalidSignature(catalogMessage(ERRORS.signatureNoRecovery, {})),
      );
    });

    it("signs when the fresh attempt is honest, through signTransaction again", async () => {
      for (const behaviour of ["otherBody", "otherKey", "malformed"] as const) {
        const adapter = fakeTxAdapter({ secretKey, behaviour, behaviourForCalls: 1 });
        const [, , filled] = FILLED[0] ?? assert.fail();

        assert.equal((await signFilled(adapter, filled)).raw, expectedRaw(filled).raw);
        assert.equal(adapter.calls.signTransaction, 2);
        assert.equal(adapter.calls.signDigest, 0);
      }
    });

    it("signs and returns the core's transaction when the adapter overwrites its copies after signing", async () => {
      for (const [, , filled] of FILLED) {
        const adapter = fakeTxAdapter({ secretKey, behaviour: "scribble" });
        assert.equal((await signFilled(adapter, filled)).raw, expectedRaw(filled).raw);
      }
    });
  });

  describe("KmsSigner.signTransaction", () => {
    const [, , filled] = FILLED[2] ?? assert.fail();
    const { unsigned } = expectedRaw(filled);

    it("signs the bytes as they were when called, whatever the caller changes later", async () => {
      const adapter = fakeTxAdapter({ secretKey });
      const kms = new KmsSigner(adapter, options);
      const bytes = new Uint8Array(unsigned);

      const pending = kms.signTransaction({ unsigned: bytes, type: 2, chainId: 31337n });
      bytes.fill(0);
      const signature = await pending;

      assert.deepEqual(adapter.transactions[0]?.unsigned, unsigned);
      const tx = Transaction.fromHex(Buffer.from(unsigned).toString("hex"), false);
      // Throws unless the signature recovers to FROM over the original bytes.
      assembleSignedTransaction(tx, signature, FROM, "eth_signTransaction");
    });

    it("hands the type and chain id through as given", async () => {
      const adapter = fakeTxAdapter({ secretKey });
      await new KmsSigner(adapter, options).signTransaction({ unsigned, type: 2, chainId: 5n });
      assert.equal(adapter.transactions[0]?.type, 2);
      assert.equal(adapter.transactions[0]?.chainId, 5n);
    });

    it("signs the keccak-256 of the bytes through signDigest when the adapter has no signTransaction", async () => {
      const digests: Uint8Array[] = [];
      const inner = fakeAdapter({ secretKey });
      const adapter: KmsKeyAdapter = {
        describe: () => inner.describe(),
        getPublicKey: async (ctx) =>
          await (inner.getPublicKey?.(ctx) ?? Promise.reject(new Error("missing"))),
        signDigest: async (request, ctx) => {
          digests.push(new Uint8Array(request.digest));
          return await (inner.signDigest?.(request, ctx) ?? Promise.reject(new Error("missing")));
        },
      };

      await new KmsSigner(adapter, options).signTransaction({ unsigned, type: 2, chainId: 31337n });

      assert.deepEqual(digests, [keccak_256(unsigned)]);
    });

    it("fails clearly when the adapter can sign neither transactions nor digests", async () => {
      const inner = fakeTxAdapter({ secretKey });
      const adapter: KmsKeyAdapter = {
        describe: () => inner.describe(),
        getPublicKey: async (ctx) =>
          await (inner.getPublicKey?.(ctx) ?? Promise.reject(new Error("missing"))),
        signMessage: async (request, ctx) =>
          await (inner.signMessage?.(request, ctx) ?? Promise.reject(new Error("missing"))),
      };

      await assertRefused(
        new KmsSigner(adapter, options).signTransaction({ unsigned, type: 2, chainId: 31337n }),
        catalogError(
          ERRORS.signerCannotSign,
          { kind: "transaction" },
          { provider: "fake", operation: "sign", key: "fake-key-1" },
        ).message,
      );
    });
  });

  describe("other requests through an adapter that has it", () => {
    it("signs digests with signDigest and messages with signMessage", async () => {
      const adapter = fakeTxAdapter({ secretKey });
      const kms = new KmsSigner(adapter, options);

      await kms.signDigest(new Uint8Array(32).fill(1));
      await kms.signPersonalMessage(Uint8Array.of(1, 2, 3));

      assert.deepEqual(adapter.calls, { signDigest: 1, signMessage: 1, signTransaction: 0 });
    });
  });

  describe("adapters without it", () => {
    for (const [type, name, filled] of FILLED) {
      it(`sign a type ${type} (${name}) transaction through signDigest, as before`, async () => {
        const adapter = fakeAdapter({ secretKey });
        assert.equal((await signFilled(adapter, filled)).raw, expectedRaw(filled).raw);
        assert.equal(adapter.calls.signDigest, 1);
      });
    }
  });
});

describe("transactionToSign", () => {
  it("gives the unsigned bytes, the EIP-2718 type number and the chain id", () => {
    for (const [type, , filled] of FILLED) {
      const { unsigned } = expectedRaw(filled);
      const tx = Transaction.fromHex(Buffer.from(unsigned).toString("hex"), false);
      assert.deepEqual(transactionToSign(tx, 99n), { unsigned, type, chainId: 99n });
    }
  });

  it("numbers a blob transaction 3", () => {
    const blob = Transaction.prepare(
      {
        type: "eip4844",
        to: TO,
        nonce: 0n,
        chainId: 1n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
        maxFeePerBlobGas: 1n,
        blobVersionedHashes: [`0x01${"00".repeat(31)}`],
        gasLimit: 21_000n,
        value: 0n,
      },
      false,
    );
    assert.equal(transactionToSign(blob, 1n).type, 3);
  });
});
