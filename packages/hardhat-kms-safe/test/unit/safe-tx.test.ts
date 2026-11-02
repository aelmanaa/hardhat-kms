// SafeTx hashes against Safe's own vectors, from safe-eth-py
// safe_eth/safe/tests/test_safe_tx.py at 0bb7cfe1391516dee7a307a1bfc4167e4e4e8f2f: L302-339 for
// 1.0.0 (no chain id in the domain) and L405-437 for 1.3.0. The 1.0.0 vectors pin the SafeTx type,
// which 1.3.0 to 1.5.0 share; the plugin refuses those Safes for their domain.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hashTypedData, type Address, type Hex } from "viem";

import {
  MAX_NONCE,
  SAFE_TX_TYPES,
  safeTransaction,
  safeTxHash,
  safeTxTypedData,
  supportedVersion,
  type SafeTransaction,
} from "../../src/internal/safe-tx.ts";

const ZERO: Address = "0x0000000000000000000000000000000000000000";

const V130 = {
  chainId: 4n,
  safe: "0x2B0b9cBDA3D7b0F760187c52A8FFB18C48E5d96A",
  tx: {
    to: "0x79613FD49472C3C7a32188e45ff00e7bdC8a897d",
    value: 2n,
    data: "0x1212",
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: "0xFA995c7a0d32A4e7497508a5C380369BE8dB49Db",
    refundReceiver: "0x6b92f5E5360bfCa8F5d3FcE65D87382967847983",
    nonce: 17n,
  },
  expected: "0x01d42a801ac44d3ebd43592be980dea0756d7f7b27d718d3016a42ea7ce85587",
} as const satisfies { chainId: bigint; safe: Address; tx: SafeTransaction; expected: Hex };

const V100: { name: string; tx: SafeTransaction; expected: Hex }[] = [
  {
    name: "L302-319",
    tx: {
      to: "0x5AC255889882aaB35A2aa939679E3F3d4Cea221E",
      value: 5000000n,
      data: "0x00",
      operation: 0,
      safeTxGas: 50000n,
      baseGas: 100n,
      gasPrice: 10000n,
      gasToken: ZERO,
      refundReceiver: ZERO,
      nonce: 67n,
    },
    expected: "0x7c60341f3e1b4483575f38e84e97d6b332a2dd55b9290f39e6e26eef29a04fe7",
  },
];

describe("SafeTx hash vectors from safe-eth-py", () => {
  it("1.3.0 domain (chain id and Safe), L405-437", () => {
    assert.equal(safeTxHash(V130.chainId, V130.safe, V130.tx), V130.expected);
  });

  it("the typed data for eth_signTypedData_v4 hashes to the same value after JSON", () => {
    const typed: unknown = JSON.parse(
      JSON.stringify(safeTxTypedData(V130.chainId, V130.safe, V130.tx)),
    );
    assert.deepEqual(typed, {
      types: SAFE_TX_TYPES,
      primaryType: "SafeTx",
      domain: { chainId: "4", verifyingContract: V130.safe },
      message: {
        to: V130.tx.to,
        value: "2",
        data: "0x1212",
        operation: 0,
        safeTxGas: "0",
        baseGas: "0",
        gasPrice: "0",
        gasToken: V130.tx.gasToken,
        refundReceiver: V130.tx.refundReceiver,
        nonce: "17",
      },
    });
  });

  for (const vector of V100) {
    it(`the SafeTx type, with the 1.0.0 domain (Safe only), ${vector.name}`, () => {
      assert.equal(
        hashTypedData({
          types: {
            EIP712Domain: [{ name: "verifyingContract", type: "address" }],
            SafeTx: SAFE_TX_TYPES.SafeTx,
          },
          primaryType: "SafeTx",
          domain: { verifyingContract: "0x692a70D2e424a56D2C6C27aA97D1a86395877b3A" },
          message: vector.tx,
        }),
        vector.expected,
      );
    });
  }
});

const refuses = (run: () => unknown, message: RegExp): void => {
  assert.throws(run, message);
};

describe("safeTransaction", () => {
  const to = "0x79613fd49472c3c7a32188e45ff00e7bdc8a897d";

  it("fills the defaults, zero refund fields, a checksummed target and lowercase data", () => {
    assert.deepEqual(safeTransaction({ to, data: "0xABCD" }, 3n), {
      to: "0x79613FD49472C3C7a32188e45ff00e7bdC8a897d",
      value: 0n,
      data: "0xabcd",
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ZERO,
      refundReceiver: ZERO,
      nonce: 3n,
    });
    assert.equal(safeTransaction({ to }, 0n).data, "0x");
    assert.equal(safeTransaction({ to, operation: 1 }, 0n).operation, 1);
  });

  it("refuses bad targets, data, values and nonces", () => {
    refuses(() => safeTransaction({ to: "0x1234" }, 0n), /to is not an address/);
    // A mixed-case address with a wrong checksum.
    refuses(
      () => safeTransaction({ to: "0x79613FD49472C3C7a32188e45ff00e7bdC8a897D" }, 0n),
      /to is not an address/,
    );
    refuses(() => safeTransaction({ to, data: "0x1" }, 0n), /not 0x-prefixed/);
    refuses(() => safeTransaction({ to, data: "1234" }, 0n), /not 0x-prefixed/);
    refuses(() => safeTransaction({ to, data: "0xzz" }, 0n), /not 0x-prefixed/);
    refuses(() => safeTransaction({ to, value: -1n }, 0n), /value cannot be negative/);
    refuses(() => safeTransaction({ to }, -1n), /nonce cannot be negative/);
    refuses(() => safeTransaction({ to }, MAX_NONCE + 1n), /above 2\^53 - 1/);
    assert.equal(safeTransaction({ to }, MAX_NONCE).nonce, MAX_NONCE);
  });

  it("supports Safe 1.3.0, 1.4.1 and 1.5.0 only", () => {
    for (const version of ["1.3.0", "1.4.1", "1.5.0"]) {
      assert.equal(supportedVersion(version), version);
    }
    for (const version of ["1.0.0", "1.1.1", "1.2.0", "1.4.0", "1.5.1", "", "1.3.0+L2"]) {
      assert.equal(supportedVersion(version), undefined);
    }
  });
});
