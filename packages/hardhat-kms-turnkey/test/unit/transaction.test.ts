import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fromRlp, type Hex, serializeTransaction, toRlp, type TransactionSerializable } from "viem";

import {
  readUnsigned,
  signatureOfSignedTransaction,
  type UnsignedTransaction,
} from "../../src/internal/transaction.ts";

/** A canonical RLP integer as hex: even length, no leading zero, 0 as empty. */
const intHex = (value: bigint): Hex => {
  const digits = value === 0n ? "" : value.toString(16);
  return `0x${digits.length % 2 === 0 ? digits : `0${digits}`}`;
};
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex.replace(/^0x/, ""), "hex"));
const CHAIN_ID = 31337;
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const R = 0x1234n;
const S = 0x5678n;
const R_HEX: Hex = `0x${R.toString(16).padStart(64, "0")}`;
const S_HEX: Hex = `0x${S.toString(16).padStart(64, "0")}`;

const common = {
  chainId: CHAIN_ID,
  nonce: 7,
  gas: 50_000n,
  to: TO,
  value: 3n,
  data: "0xabcd",
} as const;
const accessList = [
  { address: TO, storageKeys: [`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`] },
] as const;

/** One transaction of each type, with every list field set. */
const TRANSACTIONS: Array<{ type: number; fields: string[]; tx: TransactionSerializable }> = [
  {
    type: 0,
    fields: ["nonce", "gasPrice", "gas", "to", "value", "data"],
    tx: { ...common, type: "legacy", gasPrice: 9n },
  },
  {
    type: 1,
    fields: ["chainId", "nonce", "gasPrice", "gas", "to", "value", "data", "accessList"],
    tx: { ...common, type: "eip2930", gasPrice: 9n, accessList },
  },
  {
    type: 2,
    fields: [
      "chainId",
      "nonce",
      "maxPriorityFeePerGas",
      "maxFeePerGas",
      "gas",
      "to",
      "value",
      "data",
      "accessList",
    ],
    tx: { ...common, type: "eip1559", maxFeePerGas: 9n, maxPriorityFeePerGas: 2n, accessList },
  },
  {
    type: 4,
    fields: [
      "chainId",
      "nonce",
      "maxPriorityFeePerGas",
      "maxFeePerGas",
      "gas",
      "to",
      "value",
      "data",
      "accessList",
      "authorizationList",
    ],
    tx: {
      ...common,
      type: "eip7702",
      maxFeePerGas: 9n,
      maxPriorityFeePerGas: 2n,
      accessList,
      authorizationList: [
        { address: TO, chainId: CHAIN_ID, nonce: 1, r: R_HEX, s: S_HEX, yParity: 1 },
      ],
    },
  },
];

function unsignedOf(tx: TransactionSerializable): Uint8Array {
  return bytes(serializeTransaction(tx));
}

function signedOf(tx: TransactionSerializable, parity: 0 | 1 = 0): Uint8Array {
  return bytes(
    serializeTransaction(
      tx,
      tx.type === "legacy"
        ? { r: R_HEX, s: S_HEX, v: 27n + BigInt(parity) }
        : { r: R_HEX, s: S_HEX, yParity: parity },
    ),
  );
}

function expectedOf(tx: TransactionSerializable, type: number): UnsignedTransaction {
  const expected = readUnsigned(unsignedOf(tx), type, BigInt(CHAIN_ID));
  assert.ok(expected, `type ${type}`);
  return expected;
}

/** The signed transaction's RLP list, and a function that encodes a changed one back. */
function listOf(signed: Uint8Array): {
  items: unknown[];
  encode: (items: unknown[]) => Uint8Array;
} {
  const legacy = (signed[0] ?? 0) >= 0xc0;
  const hex: Hex = `0x${Buffer.from(legacy ? signed : signed.subarray(1)).toString("hex")}`;
  const decoded = fromRlp(hex, "hex");
  assert.ok(Array.isArray(decoded));
  return {
    items: [...decoded],
    encode: (items) => {
      const list = toRlp(items.map((item) => recursiveHex(item)));
      return bytes(
        legacy ? list : `0x${(signed[0] ?? 0).toString(16).padStart(2, "0")}${list.slice(2)}`,
      );
    },
  };
}

/** Re-types a decoded RLP value for toRlp. */
type Nested = Hex | readonly Nested[];
function recursiveHex(value: unknown): Nested {
  if (Array.isArray(value)) {
    return value.map((item) => recursiveHex(item));
  }
  assert.ok(typeof value === "string" && value.startsWith("0x"));
  return `0x${value.slice(2)}`;
}

function malformed(problem: string): { kind: string; problem: string } {
  return { kind: "malformed", problem };
}

describe("readUnsigned", () => {
  it("reads the core's unsigned bytes of types 0, 1, 2 and 4", () => {
    for (const { type, fields, tx } of TRANSACTIONS) {
      const expected = expectedOf(tx, type);
      assert.equal(expected.type, type);
      assert.equal(expected.chainId, BigInt(CHAIN_ID));
      assert.equal(expected.fields.length, fields.length);
    }
  });

  it("refuses type 3 and unknown types, before looking at the bytes", () => {
    const [, , eip1559] = TRANSACTIONS;
    assert.ok(eip1559);
    for (const type of [3, 5, -1, 0x7f, 256]) {
      assert.equal(readUnsigned(unsignedOf(eip1559.tx), type, BigInt(CHAIN_ID)), undefined);
    }
  });

  it("refuses bytes of another type, another chain id, or not in the unsigned form", () => {
    for (const { type, tx } of TRANSACTIONS) {
      const unsigned = unsignedOf(tx);
      assert.equal(readUnsigned(unsigned, type, BigInt(CHAIN_ID + 1)), undefined, `type ${type}`);
      assert.equal(readUnsigned(signedOf(tx), type, BigInt(CHAIN_ID)), undefined, `type ${type}`);
      assert.equal(
        readUnsigned(new Uint8Array([...unsigned, 0]), type, BigInt(CHAIN_ID)),
        undefined,
      );
      assert.equal(readUnsigned(new Uint8Array(), type, BigInt(CHAIN_ID)), undefined);
    }
    const [legacy, eip2930, eip1559] = TRANSACTIONS;
    assert.ok(legacy && eip2930 && eip1559);
    // Typed bytes named as another type, and legacy bytes named as typed.
    assert.equal(readUnsigned(unsignedOf(eip1559.tx), 1, BigInt(CHAIN_ID)), undefined);
    assert.equal(readUnsigned(unsignedOf(eip2930.tx), 0, BigInt(CHAIN_ID)), undefined);
    assert.equal(readUnsigned(unsignedOf(legacy.tx), 2, BigInt(CHAIN_ID)), undefined);
    // A type-1 list behind another type byte, and bytes of type 3 or 5 named as such.
    const typeOne = unsignedOf(eip2930.tx);
    for (const first of [2, 3, 5]) {
      const changed = typeOne.slice();
      changed[0] = first;
      assert.equal(readUnsigned(changed, 1, BigInt(CHAIN_ID)), undefined, `${first} as 1`);
      assert.equal(readUnsigned(changed, first, BigInt(CHAIN_ID)), undefined, `${first}`);
    }
    // A legacy transaction without a chain id (6 fields), and one whose last two fields are not 0.
    const chainless: TransactionSerializable = {
      type: "legacy",
      nonce: 7,
      gas: 50_000n,
      to: TO,
      value: 3n,
      data: "0xabcd",
      gasPrice: 9n,
    };
    assert.equal(readUnsigned(unsignedOf(chainless), 0, BigInt(CHAIN_ID)), undefined);
    const { items, encode } = listOf(unsignedOf(legacy.tx));
    for (const index of [7, 8]) {
      const changed = [...items];
      changed[index] = "0x01";
      assert.equal(readUnsigned(encode(changed), 0, BigInt(CHAIN_ID)), undefined);
    }
    const listed = [...items];
    listed[7] = [];
    assert.equal(readUnsigned(encode(listed), 0, BigInt(CHAIN_ID)), undefined);
    const noChain = [...items];
    noChain[6] = "0x";
    assert.equal(readUnsigned(encode(noChain), 0, 0n), undefined);
  });
});

describe("signatureOfSignedTransaction", () => {
  it("returns r, s and the parity of a signed transaction of each type", () => {
    for (const { type, tx } of TRANSACTIONS) {
      for (const parity of [0, 1] as const) {
        assert.deepEqual(
          signatureOfSignedTransaction(signedOf(tx, parity), expectedOf(tx, type)),
          { r: R, s: S, yParity: parity },
          `type ${type}, parity ${parity}`,
        );
      }
    }
  });

  it("returns a high s as it is: the core normalizes it", () => {
    const highS = (2n ** 256n - 5n).toString(16);
    for (const { type, tx } of TRANSACTIONS) {
      const { items, encode } = listOf(signedOf(tx));
      items[items.length - 1] = `0x${highS}`;
      assert.deepEqual(signatureOfSignedTransaction(encode(items), expectedOf(tx, type)), {
        r: R,
        s: 2n ** 256n - 5n,
        yParity: 0,
      });
    }
  });

  it("names the field that differs from the transaction sent", () => {
    for (const { type, fields, tx } of TRANSACTIONS) {
      const expected = expectedOf(tx, type);
      const { items, encode } = listOf(signedOf(tx));
      for (const [index, name] of fields.entries()) {
        const changed = [...items];
        const original = changed[index];
        changed[index] = Array.isArray(original) ? [] : original === "0x01" ? "0x02" : "0x01";
        assert.deepEqual(
          signatureOfSignedTransaction(encode(changed), expected),
          { kind: "transaction-mismatch", field: name },
          `type ${type}, ${name}`,
        );
      }
      // The same value in a list instead of a string differs too.
      const listed = [...items];
      listed[fields.indexOf("to")] = [listed[fields.indexOf("to")]];
      assert.deepEqual(signatureOfSignedTransaction(encode(listed), expected), {
        kind: "transaction-mismatch",
        field: "to",
      });
    }
  });

  it("refuses another type", () => {
    const byType = new Map(TRANSACTIONS.map(({ type, tx }) => [type, tx]));
    for (const { type, tx } of TRANSACTIONS) {
      const expected = expectedOf(tx, type);
      for (const [other, otherTx] of byType) {
        if (other !== type) {
          assert.deepEqual(
            signatureOfSignedTransaction(signedOf(otherTx), expected),
            { kind: "transaction-mismatch", field: "type" },
            `${other} for ${type}`,
          );
        }
      }
      assert.deepEqual(signatureOfSignedTransaction(new Uint8Array(), expected), {
        kind: "transaction-mismatch",
        field: "type",
      });
      // Type 3 and an unknown type byte, before the same list.
      const signed = signedOf(tx);
      for (const first of [3, 5, 0x7f]) {
        const changed = type === 0 ? new Uint8Array([first, ...signed]) : signed.slice();
        changed[0] = first;
        assert.deepEqual(signatureOfSignedTransaction(changed, expected), {
          kind: "transaction-mismatch",
          field: "type",
        });
      }
    }
  });

  it("refuses a legacy v that encodes another chain id, or none", () => {
    const [legacy] = TRANSACTIONS;
    assert.ok(legacy);
    const expected = expectedOf(legacy.tx, 0);
    const { items, encode } = listOf(signedOf(legacy.tx));
    for (const v of [
      27n,
      28n,
      0n,
      1n,
      34n,
      BigInt(CHAIN_ID * 2 + 34),
      BigInt(CHAIN_ID * 2 + 37),
      BigInt((CHAIN_ID + 1) * 2 + 35),
    ]) {
      const changed = [...items];
      changed[6] = intHex(v);
      assert.deepEqual(
        signatureOfSignedTransaction(encode(changed), expected),
        { kind: "transaction-mismatch", field: "chainId" },
        `v ${v}`,
      );
    }
    for (const v of [BigInt(CHAIN_ID * 2 + 35), BigInt(CHAIN_ID * 2 + 36)]) {
      const changed = [...items];
      changed[6] = intHex(v);
      assert.deepEqual(signatureOfSignedTransaction(encode(changed), expected), {
        r: R,
        s: S,
        yParity: v === BigInt(CHAIN_ID * 2 + 35) ? 0 : 1,
      });
    }
  });

  it("refuses an answer that is not a signed transaction of the expected form", () => {
    for (const { type, fields, tx } of TRANSACTIONS) {
      const expected = expectedOf(tx, type);
      const signed = signedOf(tx);
      const { items, encode } = listOf(signed);
      const notRlp = malformed("the signed transaction is not one canonical RLP list");
      const notFields = malformed(
        "the signed transaction does not have the fields of its type and a signature",
      );
      const cases: Array<[Uint8Array, unknown, string]> = [
        [signed.subarray(0, -1), notRlp, "cut short"],
        [new Uint8Array([...signed, 0]), notRlp, "a trailing byte"],
        [encode(items.slice(0, -1)), notFields, "no s"],
        [encode([...items, "0x01"]), notFields, "an extra field"],
        [encode(items.slice(0, fields.length)), notFields, "no signature"],
        [
          type === 0 ? new Uint8Array([0xc0]) : new Uint8Array([type, 0xc0]),
          notFields,
          "an empty list",
        ],
      ];
      if (type !== 0) {
        cases.push([new Uint8Array([type, 0x81, 0x01]), notRlp, "a byte string"]);
        cases.push([new Uint8Array([type]), notRlp, "the type byte alone"]);
      }
      const at = (index: number, value: unknown): Uint8Array => {
        const changed = [...items];
        changed[changed.length + index] = value;
        return encode(changed);
      };
      const badR = malformed("r is not a canonical integer of 1 to 32 bytes");
      const badS = malformed("s is not a canonical integer of 1 to 32 bytes");
      cases.push(
        [at(-2, "0x"), badR, "r = 0"],
        [at(-2, `0x00${"11".repeat(31)}`), badR, "r with a leading zero"],
        [at(-2, `0x${"11".repeat(33)}`), badR, "r of 33 bytes"],
        [at(-2, []), badR, "r as a list"],
        [at(-1, "0x"), badS, "s = 0"],
        [at(-1, `0x00${"11".repeat(31)}`), badS, "s with a leading zero"],
        [at(-1, `0x${"11".repeat(33)}`), badS, "s of 33 bytes"],
        [at(-1, []), badS, "s as a list"],
      );
      if (type === 0) {
        const badV = malformed("v is not a canonical integer of at most 32 bytes");
        cases.push(
          [at(-3, []), badV, "v as a list"],
          [at(-3, "0x00f4f5"), badV, "v with a leading zero"],
        );
      } else {
        const badParity = malformed("yParity is not 0 or 1");
        cases.push(
          [at(-3, "0x02"), badParity, "yParity 2"],
          [at(-3, "0x00"), badParity, "yParity 0 written as a zero byte"],
          [at(-3, "0x0101"), badParity, "yParity of 2 bytes"],
          [at(-3, []), badParity, "yParity as a list"],
        );
      }
      for (const [answer, problem, name] of cases) {
        assert.deepEqual(
          signatureOfSignedTransaction(answer, expected),
          problem,
          `type ${type}: ${name}`,
        );
      }
    }
  });

  it("refuses an answer longer than the transaction sent plus a signature, before decoding it", () => {
    const tooLong = malformed(
      "the signed transaction is longer than the transaction sent with a signature",
    );
    for (const { type, tx } of TRANSACTIONS) {
      const unsigned = unsignedOf(tx);
      const expected = expectedOf(tx, type);
      // Three 33-byte signature fields and a list header grown from 1 to 9 bytes.
      assert.equal(expected.maxSignedLength, unsigned.length + 3 * 33 + 8);
      assert.ok(signedOf(tx).length <= expected.maxSignedLength);
      const answer = (length: number): Uint8Array => {
        const filled = new Uint8Array(length).fill(0xc0);
        filled[0] = type === 0 ? 0xc0 : type;
        return filled;
      };
      assert.deepEqual(
        signatureOfSignedTransaction(answer(expected.maxSignedLength + 1), expected),
        tooLong,
      );
      assert.notDeepEqual(
        signatureOfSignedTransaction(answer(expected.maxSignedLength), expected),
        tooLong,
      );
      // 5 MB of empty lists: refused at once, not decoded.
      const huge = answer(5_000_000);
      const started = performance.now();
      assert.deepEqual(signatureOfSignedTransaction(huge, expected), tooLong);
      assert.ok(performance.now() - started < 1000);
    }
  });
});
