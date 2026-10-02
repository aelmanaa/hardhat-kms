import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardhatPluginError } from "hardhat/plugins";

import {
  checkSignMessage,
  formatEther,
  parseBalance,
} from "../../../src/internal/tasks/account-checks.ts";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("checkSignMessage", () => {
  it("is the fixed prefix and the random bytes in lowercase hex", () => {
    const random = new Uint8Array(32).map((_, index) => index * 8);

    assert.equal(
      text(checkSignMessage(random)),
      "hardhat-kms check-sign 0008101820283038404850586068707880889098a0a8b0b8c0c8d0d8e0e8f0f8",
    );
  });

  it("draws 32 fresh random bytes by default", () => {
    const first = text(checkSignMessage());
    const second = text(checkSignMessage());

    assert.match(first, /^hardhat-kms check-sign [0-9a-f]{64}$/);
    assert.notEqual(first, second);
  });
});

describe("parseBalance", () => {
  it("reads a hex quantity in wei", () => {
    assert.equal(parseBalance("0x0"), 0n);
    assert.equal(parseBalance("0xDE0B6B3A7640000"), 10n ** 18n);
  });

  for (const [answer, shown] of [
    [12, "number"],
    [null, "object"],
    ["", ""],
    ["0x", "0x"],
    ["12", "12"],
    ["0xzz", "0xzz"],
    [` 0x1`, " 0x1"],
    [`0x${"f".repeat(80)}g`, `0x${"f".repeat(61)}...`],
  ] as const) {
    it(`refuses ${JSON.stringify(answer)}`, () => {
      assert.throws(
        () => parseBalance(answer),
        (error: unknown) =>
          error instanceof HardhatPluginError &&
          error.message ===
            `eth_getBalance: the node answered eth_getBalance with ${shown}, not a hex quantity`,
      );
    });
  }
});

describe("formatEther", () => {
  for (const [wei, ether] of [
    [0n, "0"],
    [1n, "0.000000000000000001"],
    [10n ** 18n, "1"],
    [15n * 10n ** 17n, "1.5"],
    [123n * 10n ** 18n + 4_560_000_000_000_000n, "123.00456"],
    [10n ** 30n, "1000000000000"],
  ] as const) {
    it(`writes ${wei} wei as ${ether}`, () => {
      assert.equal(formatEther(wei), ether);
    });
  }
});
