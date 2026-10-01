// The live tests' legacy gas price. Runs offline, in `pnpm test`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { legacyGasPrice } from "./helpers/gas.ts";

const gwei = (value: number): bigint => BigInt(Math.round(value * 1e9));

describe("live test legacy gas price", () => {
  it("takes twice the base fee when the node's gas price is lower, rounded up to a gwei", () => {
    // The failed AWS run: eth_gasPrice 0.94 gwei, then a base fee of 1.12 gwei.
    assert.equal(legacyGasPrice(gwei(0.94), gwei(1.12)), gwei(3));
    assert.equal(legacyGasPrice(gwei(0.94), gwei(0.9)), gwei(2));
  });

  it("takes the node's gas price when it is higher", () => {
    assert.equal(legacyGasPrice(gwei(5.2), gwei(1)), gwei(6));
  });

  it("keeps an exact gwei and never rounds down", () => {
    assert.equal(legacyGasPrice(gwei(4), gwei(2)), gwei(4));
    assert.equal(legacyGasPrice(gwei(4) + 1n, 0n), gwei(5));
    assert.equal(legacyGasPrice(1n, 0n), gwei(1));
  });
});
