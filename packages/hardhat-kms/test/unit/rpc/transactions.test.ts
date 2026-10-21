import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
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
  type TransactionDelegates,
} from "../../../src/internal/rpc/transactions.ts";
import { KmsSigner } from "../../../src/internal/signer/kms-signer.ts";
import type { KmsAllowedDelegate } from "../../../src/types.ts";
import { NO_ALLOWLIST } from "../../helpers/delegates.ts";
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
    assert.equal(
      error.message,
      "eth_sendTransaction: the signed transaction does not recover to 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; nothing was sent",
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
        delegates: NO_ALLOWLIST,
      }),
      (error: unknown) => {
        assert.ok(error instanceof HardhatPluginError, String(error));
        assert.equal(
          error.message,
          "eth_signTransaction: the filled transaction is not from 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        );
        return true;
      },
    );
    assert.equal(adapter.calls.signDigest, 0);
  });

  it("hands the unsigned transaction to checkUnsigned, whose refusal stops the signature", async () => {
    const adapter = fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) });
    const signer = new KmsSigner(adapter, { timeoutMs: 30_000, displayMessage: async () => {} });
    const seen: string[] = [];
    await assert.rejects(
      signTransaction(signer, {
        filler: fillerOf(filledFrom(FROM)),
        method: "eth_signTransaction",
        params: [{ from: FROM }],
        from: FROM.toLowerCase(),
        delegates: NO_ALLOWLIST,
        checkUnsigned: (tx) => {
          seen.push(tx.type);
          throw new Error("refused by the check");
        },
      }),
      /refused by the check/,
    );
    assert.deepEqual(seen, ["eip1559"]);
    assert.equal(adapter.calls.signDigest, 0);
  });
});

/** A filled EIP-1559 transfer from an address, with a given authorization list. */
function filledFrom(
  from: string,
  authorizationList?: FilledTransaction["authorizationList"],
): FilledTransaction {
  return {
    from: hex(from.slice(2)),
    to: hex(TO.slice(2)),
    gas: 50_000n,
    nonce: 0n,
    chainId: 31337n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    ...(authorizationList === undefined ? {} : { authorizationList }),
  };
}

function fillerOf(filled: FilledTransaction): TransactionFiller {
  return { fill: async () => await Promise.resolve(filled) };
}

const bytes32 = (value: bigint) => hex(value.toString(16).padStart(64, "0"));

/** An authorization of TO for chain 31337, signed by cow, with its signature fields as bytes. */
function signedAuthorization(
  nonce: bigint,
  secretKey = COW_ACCOUNT.secretKey,
  chainId = 31337n,
  delegate = TO,
) {
  const request = { chainId, address: hex(delegate.slice(2)), nonce };
  const signature = secp256k1.sign(authorizationDigest(request), hex(secretKey), {
    prehash: false,
    lowS: true,
    format: "recovered",
  });
  const parsed = secp256k1.Signature.fromBytes(signature, "recovered");
  return { request, r: parsed.r, s: parsed.s, yParity: parsed.recovery };
}

const tuple = (
  nonce: bigint,
  chainId = 31337n,
  secretKey = HARDHAT_ACCOUNT_0.secretKey,
  delegate = TO,
) => {
  const signed = signedAuthorization(nonce, secretKey, chainId, delegate);
  return {
    ...signed.request,
    r: bytes32(signed.r),
    s: bytes32(signed.s),
    yParity: hex(`0${signed.yParity}`),
  };
};
function signSelfList(
  list: NonNullable<FilledTransaction["authorizationList"]>,
  nonce = 0n,
  delegates: TransactionDelegates = NO_ALLOWLIST,
) {
  const adapter = fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) });
  const signer = new KmsSigner(adapter, { timeoutMs: 30_000, displayMessage: async () => {} });
  const result = signTransaction(signer, {
    filler: fillerOf(filledFrom(FROM, list)),
    method: "eth_sendTransaction",
    params: [{ from: FROM }],
    from: FROM.toLowerCase(),
    delegates,
    chooseNonce: () => nonce,
  });
  return { adapter, result };
}
describe("final self-authorization checks (#435)", () => {
  it("refuses a self tuple after final nonce selection, without signing", async () => {
    const { adapter, result } = signSelfList([tuple(1n)], 1n);
    await assert.rejects(
      result,
      /^HardhatPluginError: eth_sendTransaction: authorizationList\[0\] is signed by the sender for nonce 1, but the final transaction requires nonce 2; nothing was signed$/,
    );
    assert.equal(adapter.calls.signDigest, 0);
  });
  it("signs consecutive self tuples, including chain zero", async () => {
    const { adapter, result } = signSelfList([tuple(2n, 0n), tuple(3n)], 1n);
    assert.equal((await result).nonce, 1n);
    assert.equal(adapter.calls.signDigest, 1);
  });
  it("refuses duplicate self nonces", async () => {
    const { adapter, result } = signSelfList([tuple(1n), tuple(1n)]);
    await assert.rejects(result, /authorizationList\[1\].*requires nonce 2/);
    assert.equal(adapter.calls.signDigest, 0);
  });
  it("refuses self tuples on another chain", async () => {
    const { adapter, result } = signSelfList([tuple(1n, 1n)]);
    await assert.rejects(
      result,
      /^HardhatPluginError: eth_sendTransaction: authorizationList\[0\] is signed by the sender for chain 1, but the transaction is for chain 31337; nothing was signed$/,
    );
    assert.equal(adapter.calls.signDigest, 0);
  });
  it("does not compare another authority's nonce or chain with the sender", async () => {
    const { result } = signSelfList([tuple(40n, 1n, COW_ACCOUNT.secretKey), tuple(1n)]);
    await result;
  });
  it("does not advance the self nonce for a high-S or unrecoverable tuple", async (t) => {
    t.mock.method(console, "warn", () => {});
    const self = tuple(1n);
    const high = {
      ...self,
      s: bytes32(CURVE_ORDER - BigInt(`0x${Buffer.from(self.s).toString("hex")}`)),
      yParity: hex(self.yParity[0] === 0 ? "01" : "00"),
    };
    const invalid = { ...self, r: bytes32(0n) };
    const { result } = signSelfList([high, invalid, self]);
    await result;
  });
});

/** A key named `deployer` with these `allowedDelegates`, on a node that answers `code`. */
function delegatesOf(
  allowedDelegates: readonly KmsAllowedDelegate[],
  code: unknown = "0x",
): TransactionDelegates & { notes: string[]; reads: string[] } {
  const notes: string[] = [];
  const reads: string[] = [];
  return {
    key: { name: "deployer", allowedDelegates },
    node: {
      chainId: async () => await Promise.resolve(31337n),
      getCode: async (address) => {
        reads.push(address);
        return await Promise.resolve(code);
      },
    },
    note: (message) => {
      notes.push(message);
    },
    notes,
    reads,
  };
}

const ZERO = "0x0000000000000000000000000000000000000000";
const CODE = "0x60fe";
const CODE_HASH = `0x${Buffer.from(keccak_256(hex(CODE.slice(2)))).toString("hex")}`;

describe("self-authorization delegates (#562)", () => {
  it("refuses a self tuple whose delegate the key does not allow, before the KMS call", async () => {
    const { adapter, result } = signSelfList([tuple(1n)], 0n, delegatesOf([]));
    await assert.rejects(
      result,
      new RegExp(
        `^HardhatPluginError: eth_sendTransaction: authorizationList\\[0\\] is signed by the sender and delegates it to ${TO} on chain 31337, which the allowedDelegates of key deployer do not allow; nothing was signed$`,
      ),
    );
    assert.equal(adapter.calls.signDigest, 0);
  });

  it("refuses a delegate listed for another chain, and names the tuple's index", async () => {
    const list = [{ address: TO, chains: [1] }] as const;
    const { adapter, result } = signSelfList(
      [tuple(40n, 1n, COW_ACCOUNT.secretKey), tuple(1n)],
      0n,
      delegatesOf(list),
    );
    await assert.rejects(
      result,
      /authorizationList\[1\] is signed by the sender and delegates it to/,
    );
    assert.equal(adapter.calls.signDigest, 0);
  });

  it("signs a transaction without an authorization list for a key with a list", async () => {
    const adapter = fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) });
    const signer = new KmsSigner(adapter, { timeoutMs: 30_000, displayMessage: async () => {} });
    const delegates = delegatesOf([]);
    await signTransaction(signer, {
      filler: fillerOf(filledFrom(FROM)),
      method: "eth_sendTransaction",
      params: [{ from: FROM }],
      from: FROM.toLowerCase(),
      delegates,
    });
    assert.equal(adapter.calls.signDigest, 1);
    assert.deepEqual(delegates.reads, []);
  });

  it("does not check a tuple signed by another authority with the same delegate", async () => {
    const { adapter, result } = signSelfList(
      [tuple(40n, 31337n, COW_ACCOUNT.secretKey)],
      0n,
      delegatesOf([]),
    );
    await result;
    assert.equal(adapter.calls.signDigest, 1);
  });

  it("signs a self tuple for a listed delegate, and one that clears the delegation", async () => {
    const listed = signSelfList([tuple(1n)], 0n, delegatesOf([{ address: TO, chains: [31337] }]));
    await listed.result;
    const revoke = signSelfList(
      [tuple(1n, 31337n, HARDHAT_ACCOUNT_0.secretKey, ZERO)],
      0n,
      delegatesOf([]),
    );
    await revoke.result;
    assert.equal(revoke.adapter.calls.signDigest, 1);
  });

  it("matches a chain-0 self tuple only to an entry for all chains", async () => {
    const forChain = signSelfList(
      [tuple(1n, 0n)],
      0n,
      delegatesOf([{ address: TO, chains: [31337] }]),
    );
    await assert.rejects(
      forChain.result,
      /delegates it to .* on chain 0, which the allowedDelegates/,
    );
    assert.equal(forChain.adapter.calls.signDigest, 0);
    const forAll = signSelfList([tuple(1n, 0n)], 0n, delegatesOf([{ address: TO, chains: "all" }]));
    await forAll.result;
  });

  it("reads a pinned delegate's code from the node and refuses a mismatch", async () => {
    const pinned = [{ address: TO, chains: "all", codeHash: CODE_HASH }] as const;
    const mismatch = delegatesOf(pinned, "0x6000");
    const refused = signSelfList([tuple(1n)], 0n, mismatch);
    await assert.rejects(refused.result, /has hash 0x[0-9a-f]{64}, which no codeHash/);
    assert.equal(refused.adapter.calls.signDigest, 0);
    assert.deepEqual(mismatch.reads, [TO]);

    const empty = signSelfList([tuple(1n)], 0n, delegatesOf(pinned, "0x"));
    await assert.rejects(empty.result, /has no code on chain 31337/);

    const matching = delegatesOf(pinned, CODE);
    await signSelfList([tuple(1n, 0n)], 0n, matching).result;
    assert.deepEqual(matching.notes, [
      `the authorization is for chain 0, valid on every chain: the code hash of ${TO} was checked on chain 31337 only`,
    ]);
  });
});

/** Signs a transfer with an authorization list and returns the warnings it printed. */
async function signWithList(
  t: TestContext,
  authorizationList: FilledTransaction["authorizationList"],
): Promise<string[]> {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => {
    warnings.push(message);
  });
  const adapter = fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey) });
  const signer = new KmsSigner(adapter, { timeoutMs: 30_000, displayMessage: async () => {} });
  const signed = await signTransaction(signer, {
    filler: fillerOf(filledFrom(FROM, authorizationList)),
    method: "eth_sendTransaction",
    params: [{ from: FROM }],
    from: FROM.toLowerCase(),
    delegates: NO_ALLOWLIST,
  });
  const type = authorizationList === undefined ? "eip1559" : "eip7702";
  assert.equal(Transaction.fromHex(signed.raw, false).type, type);
  return warnings;
}

describe("signTransaction's authorization warnings", () => {
  it("warns about nothing for a transaction without an authorization list", async (t) => {
    assert.deepEqual(await signWithList(t, undefined), []);
  });

  it("warns about nothing for low-S authorizations of either parity", async (t) => {
    const items = [0n, 1n, 2n, 3n, 4n, 5n].map((nonce) => signedAuthorization(nonce));
    const parities = new Set(items.map((item) => item.yParity));
    assert.ok(parities.has(0) && parities.has(1), "the nonces give both parities");
    const warnings = await signWithList(
      t,
      items.map(({ request, r, s, yParity }) => ({
        ...request,
        yParity: hex(yParity === 0 ? "" : "01"),
        r: bytes32(r),
        s: bytes32(s),
      })),
    );
    assert.deepEqual(warnings, []);
  });

  it("warns about a high-S signature, by its place in the list", async (t) => {
    const good = signedAuthorization(0n);
    const high = signedAuthorization(1n);
    const warnings = await signWithList(t, [
      {
        ...good.request,
        yParity: hex(good.yParity === 0 ? "" : "01"),
        r: bytes32(good.r),
        s: bytes32(good.s),
      },
      {
        ...high.request,
        // The high-S twin recovers to the same authority with the other parity.
        yParity: hex(high.yParity === 0 ? "01" : ""),
        r: bytes32(high.r),
        s: bytes32(CURVE_ORDER - high.s),
      },
    ]);
    assert.deepEqual(warnings, [
      "hardhat-kms: authorizationList[1] has a high-S signature, which EIP-7702 forbids; nodes skip this authorization. Sign it again with a low-S signer.",
    ]);
  });

  it("warns about a signature that recovers no authority, by its place in the list", async (t) => {
    const good = signedAuthorization(0n);
    const warnings = await signWithList(t, [
      {
        ...good.request,
        yParity: hex(good.yParity === 0 ? "" : "01"),
        r: bytes32(good.r),
        s: bytes32(good.s),
      },
      // r = 0 is no signature at all.
      { ...good.request, yParity: hex(""), r: bytes32(0n), s: bytes32(good.s) },
    ]);
    assert.deepEqual(warnings, [
      "hardhat-kms: authorizationList[1]'s signature does not recover to an authority; nodes skip this authorization. Check its chainId, address, nonce and signature.",
    ]);
  });
});
