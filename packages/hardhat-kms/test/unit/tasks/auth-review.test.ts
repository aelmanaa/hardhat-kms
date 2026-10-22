import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { keccak_256 } from "@noble/hashes/sha3.js";
import { HardhatPluginError } from "hardhat/plugins";

import {
  type AuthorizationReview,
  authorizationWarnings,
  delegationTarget,
  isPrecompile,
  type NodeState,
  refuseUnworkable,
  summaryLines,
} from "../../../src/internal/tasks/auth-review.ts";

const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const DELEGATE = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const OTHER = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";
const ZERO = `0x${"0".repeat(40)}`;
const delegationTo = (address: string) => `0xef0100${address.slice(2).toLowerCase()}`;

function node(overrides: Partial<NodeState> = {}): NodeState {
  return {
    network: "sepolia",
    latest: 11n,
    pending: 11n,
    accountCode: "0x",
    delegateCode: "0x6000",
    implementationSlot: 0n,
    ...overrides,
  };
}

function review(overrides: Partial<AuthorizationReview> = {}): AuthorizationReview {
  return {
    keyName: "deployer",
    account: ACCOUNT,
    delegate: DELEGATE,
    label: undefined,
    chainId: 11_155_111n,
    network: "sepolia",
    nonce: 11n,
    nonceSource: "node",
    node: node(),
    ...overrides,
  };
}

function refusal(value: AuthorizationReview): string | undefined {
  try {
    refuseUnworkable(value, "kms sign-auth");
    return undefined;
  } catch (error) {
    assert.ok(error instanceof HardhatPluginError, String(error));
    return error.message;
  }
}

describe("isPrecompile", () => {
  it("covers 0x01 to 0x1ff, not the zero address or anything above", () => {
    for (const value of [1n, 0x11n, 0x64n, 0xffn, 0x100n, 0x1ffn]) {
      assert.equal(isPrecompile(`0x${value.toString(16).padStart(40, "0")}`), true, String(value));
    }
    for (const address of [ZERO, `0x${"200".padStart(40, "0")}`, DELEGATE]) {
      assert.equal(isPrecompile(address), false, address);
    }
  });
});

describe("delegationTarget", () => {
  it("reads exactly 0xef0100 and 20 bytes, in either case, and checksums the address", () => {
    assert.equal(delegationTarget(delegationTo(OTHER)), OTHER);
    assert.equal(delegationTarget(delegationTo(OTHER).toUpperCase().replace("0X", "0x")), OTHER);
  });

  it("returns nothing for other code", () => {
    for (const code of [
      "0x",
      "0x6000",
      `${delegationTo(OTHER)}00`,
      delegationTo(OTHER).slice(0, -2),
      `0xef0200${OTHER.slice(2)}`,
    ]) {
      assert.equal(delegationTarget(code), undefined, code);
    }
  });
});

describe("refuseUnworkable", () => {
  it("checks nothing without a node", () => {
    assert.equal(refusal(review({ node: undefined, nonce: 0n })), undefined);
  });

  it("refuses a nonce below the latest one, and not the latest one or a pending one", () => {
    assert.equal(
      refusal(review({ nonce: 10n })),
      "kms sign-auth: the nonce 10 is below the account's nonce 11 on network sepolia, so the authorization could never apply. Nothing was signed",
    );
    assert.equal(refusal(review({ nonce: 11n })), undefined);
    assert.equal(refusal(review({ nonce: 12n, node: node({ pending: 13n }) })), undefined);
  });

  it("refuses a delegate whose code is a delegation, in either case", () => {
    for (const code of [delegationTo(OTHER), "0xEF0100", "0xef01"]) {
      const message = refusal(review({ node: node({ delegateCode: code }) }));
      if (code === "0xef01") {
        assert.equal(message, undefined);
      } else {
        assert.equal(
          message,
          `kms sign-auth: the delegate ${DELEGATE} is itself a delegated account on network sepolia: its code starts with 0xef0100. Clients follow one delegation only, so every call to this account would fail. Nothing was signed`,
        );
      }
    }
  });

  it("refuses an account with code that is not a delegation, and accepts one with a delegation", () => {
    assert.equal(
      refusal(review({ node: node({ accountCode: "0x600060" }) })),
      `kms sign-auth: the account ${ACCOUNT} has 3 bytes of contract code on network sepolia, which is not a delegation, so nodes would skip the authorization. Nothing was signed`,
    );
    assert.equal(refusal(review({ node: node({ accountCode: delegationTo(OTHER) }) })), undefined);
  });
});

describe("authorizationWarnings", () => {
  it("warns about nothing for an ordinary authorization, or without a node", () => {
    assert.deepEqual(authorizationWarnings(review()), []);
    assert.deepEqual(authorizationWarnings(review({ node: undefined, nonce: 99n })), []);
  });

  it("warns about a nonce above the pending count, plus one with --self-broadcast", () => {
    assert.deepEqual(authorizationWarnings(review({ nonce: 12n })), [
      "nonce 12 is ahead of the account's next nonce 11: the signature stays valid until the account reaches it, and anyone who holds it can submit it then",
    ]);
    assert.deepEqual(
      authorizationWarnings(review({ nonce: 12n, nonceSource: "self-broadcast" })),
      [],
    );
    assert.equal(
      authorizationWarnings(review({ nonce: 13n, nonceSource: "self-broadcast" })).length,
      1,
    );
    assert.deepEqual(
      authorizationWarnings(review({ nonce: 12n, node: node({ pending: 12n }) })),
      [],
    );
  });

  it("warns about a --nonce below the pending count, and not about one the node chose", () => {
    const pending = node({ latest: 11n, pending: 13n });
    assert.deepEqual(
      authorizationWarnings(review({ nonce: 12n, nonceSource: "option", node: pending })),
      [
        "nonce 12 is below the account's pending count 13: a pending transaction will likely use it first, and the authorization then cannot apply",
      ],
    );
    assert.deepEqual(
      authorizationWarnings(review({ nonce: 13n, nonceSource: "option", node: pending })),
      [],
    );
    assert.deepEqual(
      authorizationWarnings(review({ nonce: 12n, nonceSource: "node", node: pending })),
      [],
    );
  });

  it("warns about a re-delegation to another delegate, not to the same one or a revoke", () => {
    assert.deepEqual(
      authorizationWarnings(review({ node: node({ accountCode: delegationTo(OTHER) }) })),
      [
        `the account is delegated to ${OTHER} now: storage it wrote stays, and the new delegate reads and writes the same slots`,
      ],
    );
    assert.deepEqual(
      authorizationWarnings(review({ node: node({ accountCode: delegationTo(DELEGATE) }) })),
      [],
    );
    assert.deepEqual(
      authorizationWarnings(
        review({
          delegate: ZERO,
          node: node({
            accountCode: delegationTo(OTHER),
            delegateCode: undefined,
            implementationSlot: undefined,
          }),
        }),
      ),
      [],
    );
  });

  it("warns about a set ERC-1967 slot, showing its low 20 bytes", () => {
    const slot = (1n << 200n) | BigInt(OTHER);
    assert.deepEqual(authorizationWarnings(review({ node: node({ implementationSlot: slot }) })), [
      `the delegate's ERC-1967 implementation slot points to ${OTHER}: it looks like a proxy, so its code can change after you sign`,
    ]);
  });

  it("warns about a delegate without code", () => {
    assert.deepEqual(authorizationWarnings(review({ node: node({ delegateCode: "0x" }) })), [
      "the delegate has no code on network sepolia: check that it is the address for this chain",
    ]);
  });
});

describe("summaryLines", () => {
  const END = [
    "This delegates the account until another authorization replaces it.",
    "It is not undone if the transaction that carries it reverts.",
    "Anyone who holds the signature can submit it.",
  ];

  it("shows every field from the node, with the label beside the address and the warnings", () => {
    const code = `0x${"60".repeat(1234)}`;
    const hash = Buffer.from(keccak_256(Buffer.from(code.slice(2), "hex"))).toString("hex");
    const value = review({
      label: "Simple7702Account",
      nonce: 12n,
      nonceSource: "self-broadcast",
      node: node({
        pending: 12n,
        delegateCode: code,
        accountCode: delegationTo(OTHER),
      }),
    });
    const lines = summaryLines(value, ["first", "second"]);
    assert.deepEqual(lines.slice(0, 2), [
      "[hardhat-kms] EIP-7702 authorization",
      "  action      DELEGATE the account to the code at the delegate",
    ]);
    assert.deepEqual(lines.slice(2, 12), [
      `  account     ${ACCOUNT} (key deployer)`,
      `  delegate    Simple7702Account ${DELEGATE}`,
      "  chain       sepolia, 11155111",
      "  nonce       12; account nonce now 11 (12 pending); self-sponsored: yes",
      `  delegate    code 1,234 bytes, keccak 0x${hash}`,
      `  account     now delegated to ${OTHER}`,
      "  node        network sepolia; its answers are not verified",
      "  warning     first",
      "  warning     second",
      END[0],
    ]);
    assert.deepEqual(lines.slice(12), END.slice(1));
  });

  it("says not checked for each line that needs a node, with --chain alone", () => {
    assert.deepEqual(
      summaryLines(
        review({ node: undefined, network: undefined, chainId: 10n, nonceSource: "option" }),
        [],
      ),
      [
        "[hardhat-kms] EIP-7702 authorization",
        "  action      DELEGATE the account to the code at the delegate",
        `  account     ${ACCOUNT} (key deployer)`,
        `  delegate    ${DELEGATE}`,
        "  chain       10 (from --chain)",
        "  nonce       11; account nonce not checked; self-sponsored: not known (--nonce)",
        "  delegate    code not checked",
        "  account     delegation not checked",
        "  node        none: with --chain, nothing is read from a node",
        ...END,
      ],
    );
  });

  it("shows ALL CHAINS for chain 0, and REVOKE for the zero address, without a code line", () => {
    const lines = summaryLines(
      review({
        delegate: ZERO,
        label: "ignored",
        chainId: 0n,
        node: node({ delegateCode: undefined, implementationSlot: undefined }),
      }),
      [],
    );
    assert.deepEqual(lines, [
      "[hardhat-kms] EIP-7702 authorization",
      "  action      REVOKE delegation (account becomes a plain EOA again)",
      `  account     ${ACCOUNT} (key deployer)`,
      `  delegate    ${ZERO} (zero address)`,
      "  chain       ALL CHAINS (chain id 0): valid on every chain where the account's nonce is 11",
      "  nonce       11; account nonce now 11; self-sponsored: no",
      "  account     now not delegated",
      "  node        network sepolia; its answers are not verified",
      "This clears the account's delegation until another authorization sets one.",
      ...END.slice(1),
    ]);
  });

  it("shows a delegate without code as none", () => {
    const lines = summaryLines(review({ node: node({ delegateCode: "0x" }) }), []);
    assert.ok(lines.includes("  delegate    code none"), lines.join("\n"));
  });
});
