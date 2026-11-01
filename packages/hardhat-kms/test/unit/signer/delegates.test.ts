import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { keccak_256 } from "@noble/hashes/sha3.js";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { HardhatPluginError } from "hardhat/plugins";

import hardhatKms from "../../../src/index.ts";
import {
  checkDelegate,
  type DelegateCheck,
  type DelegateNode,
  keysWithLists,
  matchDelegate,
  refuseListedCopy,
  ZERO_ADDRESS,
} from "../../../src/internal/signer/delegates.ts";
import type { AwsKmsKeyConfig, KmsAllowedDelegate, KmsIdentifier } from "../../../src/types.ts";
import { vaultKey } from "../../helpers/vault-key.ts";

/** Simple7702Account, the delegate eth-infinitism deploys at the same address on every chain. */
const SIMPLE = "0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9";
/** Alchemy's Modular Account v2 v1.1.0. */
const MAV2 = "0x77021100bD87b7008E5E1989d0eB38555d0d0000";
const OTHER = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const CODE = "0x6080604052fe";
const CODE_HASH = `0x${Buffer.from(keccak_256(Buffer.from(CODE.slice(2), "hex"))).toString("hex")}`;
const OTHER_HASH = `0x${"ab".repeat(32)}`;

const LIST: readonly KmsAllowedDelegate[] = [
  { address: SIMPLE, chains: "all", label: "Simple7702Account" },
  { address: MAV2, chains: [1, 11155111], label: "Modular Account v2" },
];

describe("matchDelegate", () => {
  it("allows everything when the key has no allowedDelegates", () => {
    assert.deepEqual(matchDelegate(undefined, OTHER, 1n), { kind: "unrestricted" });
    assert.deepEqual(matchDelegate(undefined, OTHER, 0n), { kind: "unrestricted" });
  });

  it("always lets the zero address through, even with an empty list and on chain 0", () => {
    for (const chain of [0n, 1n, undefined]) {
      assert.deepEqual(matchDelegate([], ZERO_ADDRESS, chain), { kind: "revoke" });
      assert.deepEqual(matchDelegate(LIST, ZERO_ADDRESS, chain), { kind: "revoke" });
    }
  });

  it("refuses every other delegate with an empty list", () => {
    assert.deepEqual(matchDelegate([], SIMPLE, 1n), { kind: "unlisted" });
  });

  it("matches a listed chain and refuses another", () => {
    assert.deepEqual(matchDelegate(LIST, MAV2, 11155111n), {
      kind: "listed",
      label: "Modular Account v2",
      codeHashes: [],
    });
    assert.deepEqual(matchDelegate(LIST, MAV2, 1n).kind, "listed");
    assert.deepEqual(matchDelegate(LIST, MAV2, 10n), { kind: "wrong-chain" });
  });

  it("matches an entry for all chains on any chain id", () => {
    for (const chain of [1n, 10n, 11155111n, 2n ** 64n]) {
      assert.deepEqual(matchDelegate(LIST, SIMPLE, chain), {
        kind: "listed",
        label: "Simple7702Account",
        codeHashes: [],
      });
    }
  });

  it("matches a chain-0 authorization only to an entry for all chains (Ledger 1.22.4)", () => {
    // A chain-0 authorization is valid on every chain, so an entry for chain 1 must not allow it.
    assert.deepEqual(matchDelegate(LIST, MAV2, 0n), { kind: "wrong-chain" });
    assert.deepEqual(matchDelegate([{ address: MAV2, chains: [1] }], MAV2, 0n), {
      kind: "wrong-chain",
    });
    assert.deepEqual(matchDelegate(LIST, SIMPLE, 0n).kind, "listed");
    // Validation refuses chain 0 in a list; a resolved config changed in code still cannot use it.
    assert.deepEqual(matchDelegate([{ address: MAV2, chains: [0] }], MAV2, 0n), {
      kind: "wrong-chain",
    });
  });

  it("refuses an address no entry names, on any chain", () => {
    assert.deepEqual(matchDelegate(LIST, OTHER, 1n), { kind: "unlisted" });
    assert.deepEqual(matchDelegate(LIST, OTHER, 0n), { kind: "unlisted" });
    assert.deepEqual(matchDelegate(LIST, OTHER, undefined), { kind: "unlisted" });
  });

  it("compares addresses without regard to case", () => {
    assert.equal(matchDelegate(LIST, SIMPLE.toLowerCase(), 5n).kind, "listed");
    assert.equal(matchDelegate(LIST, `0x${SIMPLE.slice(2).toUpperCase()}`, 5n).kind, "listed");
  });

  it("matches the address alone when the chain is not known yet", () => {
    assert.deepEqual(matchDelegate(LIST, MAV2, undefined), {
      kind: "listed",
      label: "Modular Account v2",
      codeHashes: [],
    });
  });

  it("asks for a code check only when every matching entry pins a hash", () => {
    const pinned: readonly KmsAllowedDelegate[] = [
      { address: OTHER, chains: [1], codeHash: CODE_HASH, label: "pinned" },
      { address: OTHER, chains: "all", codeHash: OTHER_HASH },
      { address: OTHER, chains: [5], label: "unpinned on 5" },
    ];
    assert.deepEqual(matchDelegate(pinned, OTHER, 1n), {
      kind: "listed",
      label: "pinned",
      codeHashes: [CODE_HASH, OTHER_HASH],
    });
    assert.deepEqual(matchDelegate(pinned, OTHER, 2n), {
      kind: "listed",
      label: undefined,
      codeHashes: [OTHER_HASH],
    });
    // An entry without a pin matches chain 5, so no code check, and its label is used.
    assert.deepEqual(matchDelegate(pinned, OTHER, 5n), {
      kind: "listed",
      label: "unpinned on 5",
      codeHashes: [],
    });
  });
});

/** A node that answers `code` for every address and counts its calls. */
function node(code: unknown, chainId = 11155111n): DelegateNode & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    chainId: async () => await Promise.resolve(chainId),
    getCode: async (address) => {
      calls.push(address);
      return await Promise.resolve(code);
    },
  };
}

function check(
  allowedDelegates: readonly KmsAllowedDelegate[] | undefined,
  options: Partial<DelegateCheck> = {},
): DelegateCheck & { notes: string[] } {
  const notes: string[] = [];
  return {
    key: { name: "deployer", ...(allowedDelegates === undefined ? {} : { allowedDelegates }) },
    node: undefined,
    note: (message) => {
      notes.push(message);
    },
    operation: "test",
    ...options,
    notes,
  };
}

async function assertRefused(promise: Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HardhatPluginError);
    assert.equal(error.message, message);
    return true;
  });
}

describe("checkDelegate", () => {
  it("names the key, the delegate and the chain when a delegate is not allowed", async () => {
    await assertRefused(
      checkDelegate(check(LIST), OTHER, 11155111n),
      `test: key deployer may not delegate to ${OTHER} on chain 11155111: no entry of its allowedDelegates allows that delegate on that chain. Nothing was signed`,
    );
    await assertRefused(
      checkDelegate(check(LIST), MAV2, 10n),
      `test: key deployer may not delegate to ${MAV2} on chain 10: no entry of its allowedDelegates allows that delegate on that chain. Nothing was signed`,
    );
  });

  it("explains the chain-0 rule when a chain-0 authorization is refused", async () => {
    await assertRefused(
      checkDelegate(check(LIST), MAV2, 0n),
      `test: key deployer may not delegate to ${MAV2} on chain 0, which is every chain: only an allowedDelegates entry with chains: "all" allows a chain-0 authorization. Nothing was signed`,
    );
    const passed = await checkDelegate(check(LIST), SIMPLE, 0n);
    assert.equal(passed.kind, "listed");
  });

  it("uses the caller's error when it gives one", async () => {
    const chains: bigint[] = [];
    const refuse = (chain: bigint): Error => {
      chains.push(chain);
      return new Error("refused here");
    };
    await assert.rejects(checkDelegate(check(LIST, { refuse }), OTHER, 7n), /refused here/);
    await assert.rejects(checkDelegate(check(LIST, { refuse }), MAV2, 0n), /refused here/);
    assert.deepEqual(chains, [7n, 0n]);
  });

  it("passes without the node when no list, the zero address, or an unpinned entry", async () => {
    const reader = node("0x");
    assert.deepEqual(await checkDelegate(check(undefined, { node: reader }), OTHER, 1n), {
      kind: "unrestricted",
    });
    assert.deepEqual(await checkDelegate(check([], { node: reader }), ZERO_ADDRESS, 0n), {
      kind: "revoke",
    });
    assert.equal((await checkDelegate(check(LIST, { node: reader }), MAV2, 1n)).kind, "listed");
    assert.deepEqual(reader.calls, []);
  });

  describe("a pinned code hash", () => {
    const pinned: readonly KmsAllowedDelegate[] = [
      { address: OTHER, chains: "all", codeHash: CODE_HASH, label: "batcher" },
    ];

    it("passes when the code matches", async () => {
      const reader = node(CODE);
      const result = await checkDelegate(check(pinned, { node: reader }), OTHER, 11155111n);
      assert.deepEqual(result, { kind: "listed", label: "batcher", codeHashes: [CODE_HASH] });
      assert.deepEqual(reader.calls, [OTHER]);
    });

    it("compares with the hash of code in any case", async () => {
      const result = await checkDelegate(
        check(pinned, { node: node(CODE.toUpperCase().replace("0X", "0x")) }),
        OTHER,
        1n,
      );
      assert.equal(result.kind, "listed");
    });

    it("refuses other code, naming the hash it found", async () => {
      const found = `0x${Buffer.from(keccak_256(new Uint8Array([0x60, 0x00]))).toString("hex")}`;
      await assertRefused(
        checkDelegate(check(pinned, { node: node("0x6000") }), OTHER, 11155111n),
        `test: the code of delegate ${OTHER} on chain 11155111 has hash ${found}, which no codeHash in the allowedDelegates of key deployer matches. Nothing was signed`,
      );
    });

    it("refuses empty code", async () => {
      await assertRefused(
        checkDelegate(check(pinned, { node: node("0x") }), OTHER, 11155111n),
        `test: delegate ${OTHER} has no code on chain 11155111, and the allowedDelegates of key deployer pin its code hash. Nothing was signed`,
      );
    });

    it("refuses an answer that is not hex data", async () => {
      for (const answer of [undefined, null, 1, "", "6080", "0x608", "0xzz", "x0x60", ["0x60"]]) {
        await assertRefused(
          checkDelegate(check(pinned, { node: node(answer) }), OTHER, 1n),
          `test: the node's eth_getCode answer for delegate ${OTHER} is not hex data, so its pinned code hash cannot be checked. Nothing was signed`,
        );
      }
    });

    it("fails closed without a node", async () => {
      await assertRefused(
        checkDelegate(check(pinned), OTHER, 1n),
        `test: key deployer pins the code hash of delegate ${OTHER}, and with --chain there is no network to read its code from. Pass --network instead. Nothing was signed`,
      );
    });

    it("reads a chain-0 authorization's code on the node's chain, and says so", async () => {
      const passing = check(pinned, { node: node(CODE, 17000n) });
      assert.equal((await checkDelegate(passing, OTHER, 0n)).kind, "listed");
      assert.deepEqual(passing.notes, [
        `the authorization is for chain 0, valid on every chain: the code hash of ${OTHER} was checked on chain 17000 only`,
      ]);
      const other = check(pinned, { node: node(CODE) });
      await checkDelegate(other, OTHER, 1n);
      assert.deepEqual(other.notes, []);
    });

    it("passes when any matching pin matches", async () => {
      const two: readonly KmsAllowedDelegate[] = [
        { address: OTHER, chains: [1], codeHash: OTHER_HASH },
        { address: OTHER, chains: [1], codeHash: CODE_HASH },
      ];
      assert.equal(
        (await checkDelegate(check(two, { node: node(CODE) }), OTHER, 1n)).kind,
        "listed",
      );
    });
  });
});

/** An identifier; with `readable: false`, reading it fails the test. */
function identifier(value: string, readable = true): KmsIdentifier {
  return {
    get: async () => {
      assert.ok(readable, `${value} was read`);
      return await Promise.resolve(value);
    },
    display: value,
  };
}

/** An AWS key named `name`, with an `address` pin when given. */
function awsKey(
  name: string,
  keyId: string,
  options: { address?: string; readable?: boolean } = {},
): AwsKmsKeyConfig {
  return {
    name,
    displayId: name,
    timeoutMs: 30_000,
    provider: "aws",
    keyId: identifier(keyId, options.readable),
    ...(options.address === undefined ? {} : { address: options.address }),
  };
}

const COMMAND_LINE = awsKey("AWS_KMS_KEY_ID", "alias/deployer");

/** The refusal of {@link COMMAND_LINE} as a copy of `other`. */
const copyOf = (other: string): string =>
  `test: the --kms key AWS_KMS_KEY_ID is the same KMS key as ${other}, which has allowedDelegates. Name ${other} instead, so its list applies. Nothing was signed`;

describe("refuseListedCopy (#593)", () => {
  it("refuses a copy of an unpinned config key by its identifier, naming both keys", async () => {
    const listed = [
      awsKey("other", "alias/other"),
      awsKey("listed", "arn:aws:kms:eu-west-1:111122223333:alias/Deployer"),
    ];
    await assertRefused(refuseListedCopy(COMMAND_LINE, listed, "test"), copyOf("listed"));
  });

  it("refuses a copy of a pinned config key by its pin, in any case, without reading it", async () => {
    const pinned = awsKey("pinned", "alias/unreadable", {
      address: OTHER.toLowerCase(),
      readable: false,
    });
    await assertRefused(
      refuseListedCopy(COMMAND_LINE, [pinned], "test", OTHER.toUpperCase().replace("0X", "0x")),
      copyOf("pinned"),
    );
    // Before the address is known, or with another one, the pin does not match.
    await refuseListedCopy(COMMAND_LINE, [pinned], "test");
    await refuseListedCopy(COMMAND_LINE, [pinned], "test", SIMPLE);
  });

  it("passes a key that is no listed key, and reads nothing when no key has a list", async () => {
    await refuseListedCopy(COMMAND_LINE, [awsKey("other", "alias/other")], "test", SIMPLE);
    await refuseListedCopy(awsKey("AWS_KMS_KEY_ID", "alias/x", { readable: false }), [], "test");
  });
});

describe("checkDelegate with a --kms key (#593)", () => {
  const commandLine = {
    key: COMMAND_LINE,
    address: SIMPLE,
    listed: [awsKey("listed", "alias/deployer")],
  };

  it("refuses a copy of a listed key before its own list, which it does not have", async () => {
    await assertRefused(
      checkDelegate(check(undefined, { commandLine }), OTHER, 1n),
      copyOf("listed"),
    );
  });

  it("lets the zero address through, and a key that is no copy", async () => {
    // The --kms key has no list of its own.
    assert.deepEqual(await checkDelegate(check(undefined, { commandLine }), ZERO_ADDRESS, 1n), {
      kind: "unrestricted",
    });
    const other = { ...commandLine, listed: [awsKey("listed", "alias/other")] };
    assert.deepEqual(await checkDelegate(check(undefined, { commandLine: other }), OTHER, 1n), {
      kind: "unrestricted",
    });
  });
});

describe("keysWithLists (#593)", () => {
  it("lists each config key with allowedDelegates once: kms.keys, then inline network keys", async () => {
    const list = [{ address: SIMPLE, chains: "all" as const }];
    const hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKms],
      kms: {
        keys: {
          named: { ...vaultKey("named"), allowedDelegates: list },
          plain: vaultKey("plain"),
        },
      },
      networks: {
        first: {
          type: "edr-simulated",
          kmsAccounts: ["named", { ...vaultKey("inline"), allowedDelegates: [] }],
        },
        second: {
          type: "http",
          url: "http://127.0.0.1:1",
          kmsAccounts: [
            "named",
            "plain",
            vaultKey("unlisted"),
            { ...vaultKey("remote"), allowedDelegates: [] },
          ],
        },
      },
    });
    assert.deepEqual(
      keysWithLists(hre.config).map((key) => key.name),
      ["named", "first.kmsAccounts[1]", "second.kmsAccounts[3]"],
    );
  });
});
