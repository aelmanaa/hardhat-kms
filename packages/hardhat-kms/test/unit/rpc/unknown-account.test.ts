import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardhatError } from "@nomicfoundation/hardhat-errors";

import { isUnknownAccount } from "../../../src/internal/rpc/dispatcher.ts";

const ACCOUNT = "0x1111111111111111111111111111111111111111";

describe("isUnknownAccount", () => {
  it("matches Hardhat's HHE716 and -32000 errors that start with 'unknown account'", () => {
    assert.ok(
      isUnknownAccount(
        new HardhatError(HardhatError.ERRORS.CORE.NETWORK.NOT_LOCAL_ACCOUNT, { account: ACCOUNT }),
      ),
    );
    // Hardhat's simulated network.
    assert.ok(isUnknownAccount({ code: -32000, message: `Unknown account ${ACCOUNT}` }));
    // Geth and Reth.
    assert.ok(isUnknownAccount({ code: -32000, message: "unknown account" }));
    assert.ok(isUnknownAccount({ code: -32000, message: "  UNKNOWN ACCOUNT" }));
  });

  it("matches nothing else", () => {
    assert.ok(
      !isUnknownAccount(
        new HardhatError(HardhatError.ERRORS.CORE.NETWORK.CONNECTION_REFUSED, { network: "x" }),
      ),
    );
    assert.ok(!isUnknownAccount({ code: -32601, message: "unknown account" }));
    assert.ok(!isUnknownAccount({ code: "-32000", message: "unknown account" }));
    assert.ok(!isUnknownAccount({ code: -32000, message: "unknown accounts are not allowed" }));
    assert.ok(!isUnknownAccount({ code: -32000, message: "nonce too low" }));
    assert.ok(
      !isUnknownAccount({ code: -32000, message: `the account ${ACCOUNT} is unknown account` }),
    );
    assert.ok(!isUnknownAccount({ code: -32000 }));
    assert.ok(!isUnknownAccount(new Error("unknown account")));
    assert.ok(!isUnknownAccount("unknown account"));
    assert.ok(!isUnknownAccount(undefined));
  });
});
