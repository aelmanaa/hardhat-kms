import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type Hex, toRlp } from "viem";

import { decodeRlp, MAX_DEPTH, type RlpItem, rlpInteger } from "../../src/internal/rlp.ts";

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const hexOf = (value: Uint8Array) => Buffer.from(value).toString("hex");

/** Lists nested `depth` deep in one another, around an empty list. */
function nested(depth: number): string {
  return depth === 0 ? "c0" : `${(0xc0 + depth).toString(16)}${nested(depth - 1)}`;
}

/** The item a hex encoding decodes to. */
function item(hex: string): RlpItem | undefined {
  return decodeRlp(bytes(hex));
}

/** The item as nested hex strings, to compare with what viem encoded. */
function plain(value: RlpItem): unknown {
  return value.kind === "bytes" ? hexOf(value.value) : value.items.map(plain);
}

describe("decodeRlp", () => {
  it("decodes what viem encodes, short and long forms, and keeps each item's encoding", () => {
    const long = "ab".repeat(56);
    const longer = "cd".repeat(300);
    const cases: Array<[Parameters<typeof toRlp>[0], unknown]> = [
      ["0x", ""],
      ["0x00", "00"],
      ["0x7f", "7f"],
      ["0x80", "80"],
      [`0x${"11".repeat(55)}`, "11".repeat(55)],
      [`0x${long}`, long],
      [`0x${longer}`, longer],
      // A long-form length whose second byte is zero: 256 bytes.
      [`0x${"ef".repeat(256)}`, "ef".repeat(256)],
      [[], []],
      [
        ["0x01", ["0x", "0x0203"]],
        ["01", ["", "0203"]],
      ],
      [Array.from({ length: 30 }, (): Hex => "0x0102"), Array.from({ length: 30 }, () => "0102")],
    ];
    for (const [value, expected] of cases) {
      const encoded = toRlp(value);
      const decoded = item(encoded.slice(2));
      assert.ok(decoded, encoded);
      assert.deepEqual(plain(decoded), expected, encoded);
      assert.equal(hexOf(decoded.encoded), encoded.slice(2));
    }
  });

  it("keeps the encoding of each item in a list", () => {
    const list = item("c88180820102c20304");
    assert.ok(list?.kind === "list");
    assert.deepEqual(
      list.items.map((child) => hexOf(child.encoded)),
      ["8180", "820102", "c20304"],
    );
  });

  it("refuses an encoding that is not canonical", () => {
    for (const hex of [
      // A byte below 0x80 behind 0x81.
      "8100",
      "817f",
      // A long-form length of 55 or less, and one with a leading zero.
      `b837${"11".repeat(55)}`,
      `b90038${"11".repeat(56)}`,
      `f837${"c0".repeat(55)}`,
      `f90038${"c0".repeat(56)}`,
    ]) {
      assert.equal(decodeRlp(bytes(hex)), undefined, hex);
    }
  });

  it("refuses an empty input, trailing bytes and items that run past the end", () => {
    for (const hex of [
      "",
      "0000",
      "c0c0",
      "8001",
      "82",
      "8201",
      "c2",
      "c201",
      // A list whose item runs past the list, at the end of the input or not.
      "c182",
      "c182ffff",
      "c3c28201",
      // A list whose item's long-form header is cut off by the list's end.
      "c1b8",
      "c1f8",
      "c2b9ff",
      "c3820102ff",
      // A long-form length that runs past the end, or whose length bytes are missing.
      "b8",
      "b838",
      `b838${"11".repeat(55)}`,
      "f8",
      "bfffffffffffffffff",
      "ffffffffffffffffff",
    ]) {
      assert.equal(decodeRlp(bytes(hex)), undefined, hex);
    }
  });

  it("decodes lists nested up to the limit, and refuses deeper ones", () => {
    assert.ok(decodeRlp(bytes(nested(MAX_DEPTH))));
    assert.equal(decodeRlp(bytes(nested(MAX_DEPTH + 1))), undefined);
  });
});

describe("rlpInteger", () => {
  it("reads canonical big-endian integers, zero as the empty string", () => {
    assert.equal(rlpInteger(item("80"), 32), 0n);
    assert.equal(rlpInteger(item("01"), 32), 1n);
    assert.equal(rlpInteger(item("7f"), 1), 127n);
    assert.equal(rlpInteger(item("8180"), 1), 128n);
    assert.equal(rlpInteger(item("820100"), 2), 256n);
    assert.equal(rlpInteger(item(`a0${"ff".repeat(32)}`), 32), 2n ** 256n - 1n);
  });

  it("refuses a leading zero, a list, a missing item and too many bytes", () => {
    assert.equal(rlpInteger(item("00"), 32), undefined);
    assert.equal(rlpInteger(item("820001"), 32), undefined);
    assert.equal(rlpInteger(item("c0"), 32), undefined);
    assert.equal(rlpInteger(undefined, 32), undefined);
    assert.equal(rlpInteger(item("820100"), 1), undefined);
    assert.equal(rlpInteger(item(`a1${"01".repeat(33)}`), 32), undefined);
  });
});
