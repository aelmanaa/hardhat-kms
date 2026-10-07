import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardhatError } from "@nomicfoundation/hardhat-errors";

import {
  isUnknownAccount,
  kmsAccountsSentence,
  withSentence,
} from "../../../src/internal/rpc/dispatcher.ts";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const addresses = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`);

describe("isUnknownAccount", () => {
  it("matches Hardhat's HHE716 and the nodes' unknown-account errors", () => {
    assert.ok(
      isUnknownAccount(
        new HardhatError(HardhatError.ERRORS.CORE.NETWORK.NOT_LOCAL_ACCOUNT, { account: ACCOUNT }),
      ),
    );
    // Hardhat's simulated network.
    assert.ok(isUnknownAccount({ code: -32000, message: `Unknown account ${ACCOUNT}` }));
    // Geth.
    assert.ok(isUnknownAccount({ code: -32000, message: "unknown account" }));
    assert.ok(isUnknownAccount({ code: -32000, message: "  UNKNOWN ACCOUNT" }));
    // Reth.
    assert.ok(isUnknownAccount({ code: -32602, message: "unknown account" }));
    assert.ok(isUnknownAccount({ code: -32602, message: "Unknown Account" }));
    assert.ok(isUnknownAccount({ code: -32602, message: "  unknown account  " }));
    // Anvil.
    assert.ok(isUnknownAccount({ code: -32602, message: "No Signer available" }));
    assert.ok(isUnknownAccount({ code: -32602, message: " No Signer available\n" }));
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
    // -32602 is invalid params: only the exact messages count.
    assert.ok(!isUnknownAccount({ code: -32602, message: "invalid argument 0: hex string" }));
    assert.ok(!isUnknownAccount({ code: -32602, message: `unknown account ${ACCOUNT}` }));
    assert.ok(!isUnknownAccount({ code: -32602, message: "unknown accounts" }));
    assert.ok(!isUnknownAccount({ code: -32602, message: "no unknown account" }));
    // A message that is not a string, even one that reads as the text.
    assert.ok(!isUnknownAccount({ code: -32000, message: ["unknown account"] }));
    assert.ok(!isUnknownAccount({ code: -32602, message: "No Signer available for 0x1" }));
    assert.ok(!isUnknownAccount({ code: -32000, message: "No Signer available" }));
    assert.ok(!isUnknownAccount({ code: -32603, message: "No Signer available" }));
    assert.ok(!isUnknownAccount({ code: -32000 }));
    assert.ok(!isUnknownAccount(new Error("unknown account")));
    assert.ok(!isUnknownAccount("unknown account"));
    assert.ok(!isUnknownAccount(undefined));
  });
});

describe("kmsAccountsSentence", () => {
  it("names one account, or up to ten, then how many more", () => {
    assert.equal(kmsAccountsSentence([]), undefined);
    assert.equal(kmsAccountsSentence([ACCOUNT]), `The KMS account on this network is ${ACCOUNT}.`);
    assert.equal(
      kmsAccountsSentence(addresses(10)),
      `The KMS accounts on this network are ${addresses(10).join(", ")}.`,
    );
    assert.equal(
      kmsAccountsSentence(addresses(11)),
      `The KMS accounts on this network are ${addresses(10).join(", ")} and 1 more.`,
    );
  });
});

describe("withSentence", () => {
  it("adds a full stop when the message has none, and appends once", () => {
    assert.equal(withSentence("unknown account", "S."), "unknown account. S.");
    assert.equal(withSentence("Not managed.  ", "S."), "Not managed. S.");
    assert.equal(withSentence("Is 0x1.a known", "S."), "Is 0x1.a known. S.");
    assert.equal(withSentence("Who?", "S."), "Who? S.");
    assert.equal(withSentence("Stop!", "S."), "Stop! S.");
    assert.equal(withSentence("unknown account. S.", "S."), "unknown account. S.");
  });
});
