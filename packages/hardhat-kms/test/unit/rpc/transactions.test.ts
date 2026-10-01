import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HardhatPluginError } from "hardhat/plugins";
import { authorization, Transaction } from "micro-eth-signer";

import { authorizationDigest } from "../../../src/internal/crypto/digests.ts";
import {
  type FilledTransaction,
  signingHash,
  type TransactionFiller,
} from "../../../src/internal/rpc/transaction-filler.ts";
import {
  assembleSignedTransaction,
  signTransaction,
} from "../../../src/internal/rpc/transactions.ts";
import { KmsSigner } from "../../../src/internal/signer/kms-signer.ts";
import { fakeAdapter } from "../../helpers/fake-adapter.ts";
import { COW_ACCOUNT, HARDHAT_ACCOUNT_0 } from "../../helpers/vectors.ts";

const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const FROM = HARDHAT_ACCOUNT_0.address;
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const CURVE_ORDER = secp256k1.Point.CURVE().n;

const unsigned = Transaction.prepare(
  {
    to: TO,
    nonce: 0n,
    chainId: 31337n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    gasLimit: 21_000n,
    value: 0n,
  },
  false,
);

/** Signs the transaction's hash with a secret key, low-S, with its recovery bit. */
function signWith(secretKey: string) {
  const signature = secp256k1.sign(signingHash(unsigned), hex(secretKey), {
    prehash: false,
    lowS: true,
    format: "recovered",
  });
  const parsed = secp256k1.Signature.fromBytes(signature, "recovered");
  const yParity = parsed.recovery === 1 ? 1 : 0;
  return { r: parsed.r, s: parsed.s, yParity } as const;
}

function assertMismatch(run: () => unknown): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof HardhatPluginError, String(error));
    assert.match(
      error.message,
      /does not recover to 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; nothing was sent/,
    );
    return true;
  });
}

describe("assembleSignedTransaction", () => {
  it("matches micro-eth-signer's signBy", () => {
    const signed = assembleSignedTransaction(
      unsigned,
      signWith(HARDHAT_ACCOUNT_0.secretKey),
      FROM.toLowerCase(),
      "eth_sendTransaction",
    );
    assert.equal(
      signed.toHex(true),
      unsigned.signBy(hex(HARDHAT_ACCOUNT_0.secretKey), false).toHex(true),
    );
  });

  it("keeps strict mode off, as Transaction#signBy does", () => {
    // Strict mode refuses fees of 10000 gwei and more, which a congested chain can need.
    const expensive = Transaction.prepare(
      { ...unsigned.raw, maxFeePerGas: 20_000n * 10n ** 9n, maxPriorityFeePerGas: 1n },
      false,
    );
    const signature = secp256k1.sign(signingHash(expensive), hex(HARDHAT_ACCOUNT_0.secretKey), {
      prehash: false,
      lowS: true,
      format: "recovered",
    });
    const parsed = secp256k1.Signature.fromBytes(signature, "recovered");
    const signed = assembleSignedTransaction(
      expensive,
      { r: parsed.r, s: parsed.s, yParity: parsed.recovery === 1 ? 1 : 0 },
      FROM,
      "eth_sendTransaction",
    );
    assert.equal(
      signed.toHex(true),
      expensive.signBy(hex(HARDHAT_ACCOUNT_0.secretKey), false).toHex(true),
    );
  });

  it("refuses a signature that recovers to another address", () => {
    assertMismatch(() =>
      assembleSignedTransaction(
        unsigned,
        signWith(COW_ACCOUNT.secretKey),
        FROM,
        "eth_sendTransaction",
      ),
    );
  });

  it("refuses a signature that cannot be recovered", () => {
    const { r, s, yParity } = signWith(HARDHAT_ACCOUNT_0.secretKey);
    // micro-eth-signer refuses to recover a high-S signature.
    const highS = { r, s: CURVE_ORDER - s, yParity: yParity === 0 ? 1 : 0 } as const;
    assertMismatch(() => assembleSignedTransaction(unsigned, highS, FROM, "eth_sendTransaction"));
  });
});

describe("authorizationDigest", () => {
  it("equals micro-eth-signer's EIP-7702 authorization hash", () => {
    for (const request of [
      { chainId: 31337n, address: TO, nonce: 1n },
      { chainId: 0n, address: FROM, nonce: 0n },
      { chainId: 2n ** 64n, address: TO, nonce: 2n ** 63n },
    ]) {
      assert.deepEqual(
        authorizationDigest({ ...request, address: hex(request.address.slice(2)) }),
        authorization._getHash(request),
      );
    }
  });
});

describe("signTransaction", () => {
  it("refuses a filled transaction from another sender before signing", async () => {
    const adapter = fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) });
    const signer = new KmsSigner(adapter, { timeoutMs: 30_000, displayMessage: async () => {} });
    const filled: FilledTransaction = {
      from: hex(COW_ACCOUNT.address.slice(2)),
      to: hex(TO.slice(2)),
      gas: 21_000n,
      nonce: 0n,
      chainId: 31337n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    };
    const filler: TransactionFiller = { fill: async () => await Promise.resolve(filled) };
    await assert.rejects(
      signTransaction(signer, {
        filler,
        method: "eth_signTransaction",
        params: [{ from: FROM }],
        from: FROM.toLowerCase(),
      }),
      (error: unknown) => {
        assert.ok(error instanceof HardhatPluginError, String(error));
        assert.match(error.message, /the filled transaction is not from 0xf39Fd6/);
        return true;
      },
    );
    assert.equal(adapter.calls.signDigest, 0);
  });
});
