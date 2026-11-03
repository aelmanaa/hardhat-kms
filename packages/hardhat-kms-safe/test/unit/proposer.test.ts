import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { networkSignsInProcess } from "../../src/internal/proposer.ts";

/** An HD config as Hardhat 3.20 resolves `accounts: { mnemonic }`. */
const HD = { mnemonic: {}, count: 20, initialIndex: 0, passphrase: {}, path: "m/44'/60'/0'/0" };

describe("networkSignsInProcess", () => {
  it("is true only for the shapes Hardhat signs for itself", () => {
    assert.equal(networkSignsInProcess({ type: "edr-simulated", accounts: [] }), true);
    assert.equal(networkSignsInProcess({ type: "http", accounts: [{}] }), true);
    assert.equal(networkSignsInProcess({ type: "http", accounts: [] }), true);
    assert.equal(networkSignsInProcess({ type: "http", accounts: HD }), true);
  });

  it("treats remote accounts and anything it does not recognise as the node's", () => {
    assert.equal(networkSignsInProcess({ type: "http", accounts: "remote" }), false);
    assert.equal(networkSignsInProcess({ type: "http" }), false);
    assert.equal(networkSignsInProcess({ type: "http", accounts: null }), false);
    assert.equal(networkSignsInProcess({ type: "http", accounts: { mnemonic: {} } }), false);
    assert.equal(networkSignsInProcess({ type: "http", accounts: "local" }), false);
    assert.equal(networkSignsInProcess({ type: "websocket", accounts: [] }), false);
    assert.equal(networkSignsInProcess({ type: undefined, accounts: [] }), false);
  });
});
