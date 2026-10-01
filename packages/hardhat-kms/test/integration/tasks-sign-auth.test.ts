import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { rpcAuthorizationList } from "@nomicfoundation/hardhat-zod-utils/rpc";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { HardhatPluginError } from "hardhat/plugins";
import type { NetworkUserConfig } from "hardhat/types/config";
import { privateKeyToAccount } from "viem/accounts";
import { recoverAuthorizationAddress } from "viem/utils";

import hardhatKms from "../../src/index.ts";
import { KmsSigner } from "../../src/internal/signer/kms-signer.ts";
import { type FakeAdapter, fakeAdapter } from "../helpers/fake-adapter.ts";
import { type RecordingNode, startRecordingNode } from "../helpers/recording-node.ts";
import { vaultKey } from "../helpers/vault-key.ts";
import { COW_ACCOUNT, HARDHAT_ACCOUNT_0 } from "../helpers/vectors.ts";

const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const ACCOUNT_0 = privateKeyToAccount(`0x${HARDHAT_ACCOUNT_0.secretKey}`);
/** The code to delegate to; any address works, code or not. */
const DELEGATE: `0x${string}` = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const ZERO: `0x${string}` = `0x${"0".repeat(40)}`;
/** Hardhat's second default account, which the simulated network holds itself. */
const HARDHAT_ACCOUNT_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

type ClosableAdapter = FakeAdapter & { closed: number };

function closableAdapter(secretKey: string): ClosableAdapter {
  const adapter = Object.assign(fakeAdapter({ secretKey: hex(secretKey) }), { closed: 0 });
  adapter.close = async () => {
    adapter.closed++;
  };
  return adapter;
}

/**
 * A runtime whose `deployer` key is {@link HARDHAT_ACCOUNT_0} and whose `sponsor` key is
 * {@link COW_ACCOUNT}, both served by fake adapters, with a Prague `local` simulated network that
 * holds both as KMS accounts. `simulatedBalance` funds both on each connection.
 */
async function runtime(options: {
  network?: string;
  networks?: Record<string, NetworkUserConfig>;
  simulatedBalance?: bigint;
}) {
  const hre = await createHardhatRuntimeEnvironment(
    {
      plugins: [hardhatKms],
      kms: {
        keys: { deployer: vaultKey("deployer"), sponsor: vaultKey("sponsor") },
        ...(options.simulatedBalance === undefined
          ? {}
          : { simulatedBalance: options.simulatedBalance }),
      },
      networks: {
        local: { type: "edr-simulated", hardfork: "prague", kmsAccounts: ["deployer", "sponsor"] },
        ...options.networks,
      },
    },
    options.network === undefined ? {} : { network: options.network },
  );
  const created: ClosableAdapter[] = [];
  const secretKeys: Record<string, string> = {
    deployer: HARDHAT_ACCOUNT_0.secretKey,
    sponsor: COW_ACCOUNT.secretKey,
  };
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async (context, key, next) => {
      const secretKey = secretKeys[key.name];
      if (secretKey === undefined) {
        return await next(context, key);
      }
      const adapter = closableAdapter(secretKey);
      created.push(adapter);
      return adapter;
    },
  });
  return { hre, created };
}

type Runtime = Awaited<ReturnType<typeof runtime>>["hre"];

interface SignAuthArgs {
  key?: string;
  delegate?: string;
  chain?: string;
  nonce?: string;
  selfBroadcast?: boolean;
  force?: boolean;
}

/** What the last run printed, kept when the run fails. */
const output = { printed: "", warned: "" };

async function signAuth(
  hre: Runtime,
  args: SignAuthArgs,
): Promise<{ result: unknown; printed: string; warned: string }> {
  output.printed = "";
  output.warned = "";
  const write = mock.method(process.stdout, "write", (chunk: unknown) => {
    output.printed += String(chunk);
    return true;
  });
  const writeError = mock.method(process.stderr, "write", (chunk: unknown) => {
    output.warned += String(chunk);
    return true;
  });
  try {
    const result: unknown = await hre.tasks.getTask(["kms", "sign-auth"]).run({
      key: "deployer",
      delegate: DELEGATE,
      selfBroadcast: false,
      force: false,
      ...args,
    });
    return { result, ...output };
  } finally {
    write.mock.restore();
    writeError.mock.restore();
  }
}

async function assertKmsError(promise: Promise<unknown>, includes: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HardhatPluginError, String(error));
    assert.ok(error.message.includes(includes), `"${error.message}" should include "${includes}"`);
    return true;
  });
}

/** The printed tuple, parsed; also checks that it is the only line on standard output. */
function tupleOf(printed: string): Record<string, string> {
  const lines = printed.split("\n");
  assert.equal(lines.length, 2, printed);
  assert.equal(lines[1], "");
  const parsed: unknown = JSON.parse(lines[0] ?? "");
  assert.ok(typeof parsed === "object" && parsed !== null);
  const tuple: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    assert.equal(typeof value, "string", name);
    tuple[name] = String(value);
  }
  return tuple;
}

/** viem's authorization for the same key and fields, as hex fields. */
async function viemAuthorization(chainId: number, nonce: number, address = DELEGATE) {
  const signed = await ACCOUNT_0.signAuthorization({ address, chainId, nonce });
  return { yParity: `0x${signed.yParity ?? 0}`, r: signed.r, s: signed.s };
}

/** A runtime whose `local` node answers `eth_getTransactionCount` with `count`. */
async function withPendingCount(count: unknown) {
  const made = await runtime({ network: "local" });
  made.hre.hooks.registerHandlers("network", {
    onRequest: async (context, connection, request, next) => {
      if (request.method === "eth_getTransactionCount") {
        return { jsonrpc: "2.0", id: request.id, result: count };
      }
      return await next(context, connection, request);
    },
  });
  return made;
}

/** Signs with the task, then sends a transaction carrying the tuple from `sender`. */
async function sendDelegation(sender: "deployer" | "sponsor" | "hardhat", args: SignAuthArgs) {
  // The sponsor is not one of Hardhat's funded accounts.
  const { hre } = await runtime({ network: "local", simulatedBalance: 10n ** 18n });
  const { result } = await signAuth(hre, args);
  // Each connection to an edr-simulated network starts a new chain, so this one starts from the
  // same state as the task's.
  const connection = await hre.network.create("local");
  try {
    const authority = HARDHAT_ACCOUNT_0.address;
    const from = {
      deployer: authority,
      sponsor: COW_ACCOUNT.address,
      hardhat: HARDHAT_ACCOUNT_1,
    }[sender];
    const hash: unknown = await connection.provider.request({
      method: "eth_sendTransaction",
      params: [{ from, to: authority, authorizationList: [result] }],
    });
    const receipt: unknown = await connection.provider.request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    });
    assert.ok(typeof receipt === "object" && receipt !== null && "type" in receipt);
    assert.equal(receipt.type, "0x4");
    const code: unknown = await connection.provider.request({
      method: "eth_getCode",
      params: [authority, "latest"],
    });
    return code;
  } finally {
    await connection.close();
  }
}

describe("kms sign-auth", () => {
  it("prints the authorization tuple Hardhat accepts, equal to viem's, and closes its signer", async () => {
    const { hre, created } = await runtime({});

    const { result, printed, warned } = await signAuth(hre, { chain: "1", nonce: "0" });

    const tuple = tupleOf(printed);
    assert.deepEqual(Object.keys(tuple), ["chainId", "address", "nonce", "yParity", "r", "s"]);
    assert.deepEqual(result, tuple);
    assert.equal(tuple.chainId, "0x1");
    assert.equal(tuple.address, DELEGATE);
    assert.equal(tuple.nonce, "0x0");
    assert.match(tuple.r ?? "", /^0x[0-9a-f]{64}$/);
    assert.match(tuple.s ?? "", /^0x[0-9a-f]{64}$/);
    assert.deepEqual(
      { yParity: tuple.yParity, r: tuple.r, s: tuple.s },
      await viemAuthorization(1, 0),
    );
    // The schema Hardhat validates eth_sendTransaction's authorizationList with.
    assert.equal(rpcAuthorizationList.safeParse([tuple]).success, true);
    // It takes hex quantities only: a decimal string is refused.
    assert.equal(rpcAuthorizationList.safeParse([{ ...tuple, chainId: "1" }]).success, false);
    assert.equal(
      await recoverAuthorizationAddress({
        authorization: { address: DELEGATE, chainId: 1, nonce: 0 },
        signature: {
          r: `0x${(tuple.r ?? "").slice(2)}`,
          s: `0x${(tuple.s ?? "").slice(2)}`,
          yParity: Number(tuple.yParity),
        },
      }),
      HARDHAT_ACCOUNT_0.address,
    );
    assert.equal(warned, "");
    assert.equal(created.length, 1);
    assert.equal(created[0]?.closed, 1);
  });

  it("reads --chain and --nonce in decimal or hex, and checksums the delegate", async () => {
    const { hre } = await runtime({});

    const { result } = await signAuth(hre, {
      chain: "0xaa36a7",
      nonce: "300",
      delegate: DELEGATE.toLowerCase(),
    });

    assert.deepEqual(result, {
      chainId: "0xaa36a7",
      address: DELEGATE,
      nonce: "0x12c",
      ...(await viemAuthorization(11_155_111, 300)),
    });
  });

  it("refuses a delegate that is not an address, before any KMS call", async () => {
    const { hre, created } = await runtime({});
    const badChecksum = `${DELEGATE.slice(0, -1)}A`;

    for (const delegate of ["0x1234", "deployer", badChecksum]) {
      await assertKmsError(
        signAuth(hre, { chain: "1", nonce: "0", delegate }),
        `the delegate ${delegate} is not an address`,
      );
    }
    assert.equal(created.length, 0);
  });

  it("refuses flags that do not go together, before any KMS call", async () => {
    const { hre, created } = await runtime({});
    const withNetwork = await runtime({ network: "local" });

    await assertKmsError(signAuth(hre, { nonce: "0" }), "pass --chain, or --network");
    await assertKmsError(
      signAuth(withNetwork.hre, { chain: "1" }),
      "pass --chain or --network, not both",
    );
    await assertKmsError(
      signAuth(withNetwork.hre, { nonce: "1", selfBroadcast: true }),
      "--nonce cannot be combined with --self-broadcast",
    );
    await assertKmsError(
      signAuth(hre, { chain: "1" }),
      "pass --nonce, or --network to read the key's pending nonce",
    );
    await assertKmsError(
      signAuth(hre, { chain: "1", selfBroadcast: true }),
      "pass --nonce, or --network to read the key's pending nonce",
    );
    assert.equal(created.length + withNetwork.created.length, 0);
  });

  it("refuses values that are not a chain id or a nonce", async () => {
    const { hre, created } = await runtime({});

    await assertKmsError(
      signAuth(hre, { chain: "mainnet", nonce: "0" }),
      "--chain is not a chain id",
    );
    await assertKmsError(
      signAuth(hre, { chain: `0x1${"0".repeat(64)}`, nonce: "0" }),
      "--chain does not fit in 256 bits",
    );
    await assertKmsError(signAuth(hre, { chain: "1", nonce: "-1" }), "--nonce is not a nonce");
    await assertKmsError(signAuth(hre, { chain: "1", nonce: "1.5" }), "--nonce is not a nonce");
    assert.equal(created.length, 0);
    await assertKmsError(
      signAuth(hre, { chain: "1", nonce: (2n ** 64n - 1n).toString() }),
      "EIP-7702 needs one below 2^64 - 1",
    );
    assert.equal(created[0]?.calls.signDigest, 0);
  });

  it("signs the largest nonce EIP-7702 allows", async () => {
    const { hre } = await runtime({});

    const { printed } = await signAuth(hre, { chain: "1", nonce: (2n ** 64n - 2n).toString() });

    assert.equal(tupleOf(printed).nonce, "0xfffffffffffffffe");
  });

  describe("chain 0", () => {
    it("is refused without --force, before any KMS call", async () => {
      const { hre, created } = await runtime({});

      await assertKmsError(
        signAuth(hre, { chain: "0", nonce: "0" }),
        "an authorization for chain 0 is valid on every chain. Pass --force to sign it anyway",
      );
      await assertKmsError(
        signAuth(hre, { chain: "0x0", nonce: "0" }),
        "Pass --force to sign it anyway",
      );
      assert.equal(created.length, 0);
    });

    it("is signed with --force, with a warning on stderr", async () => {
      const { hre } = await runtime({});

      const { result, warned } = await signAuth(hre, { chain: "0", nonce: "5", force: true });

      assert.deepEqual(result, {
        chainId: "0x0",
        address: DELEGATE,
        nonce: "0x5",
        ...(await viemAuthorization(0, 5)),
      });
      assert.equal(
        warned,
        "[hardhat-kms] this authorization is for chain 0: it is valid on every chain\n",
      );
    });

    it("is refused when the --network config names it", async () => {
      const { hre, created } = await runtime({
        network: "zero",
        networks: { zero: { type: "http", url: "http://127.0.0.1:1", chainId: 0 } },
      });

      await assertKmsError(signAuth(hre, { nonce: "0" }), "Pass --force to sign it anyway");
      assert.equal(created.length, 0);
    });
  });

  it("notes that the zero address clears the delegation", async () => {
    const { hre } = await runtime({});

    const { result, warned } = await signAuth(hre, { chain: "1", nonce: "0", delegate: ZERO });

    assert.deepEqual(result, {
      chainId: "0x1",
      address: ZERO,
      nonce: "0x0",
      ...(await viemAuthorization(1, 0, ZERO)),
    });
    assert.match(
      warned,
      /the delegate is the zero address: this authorization clears the delegation/,
    );
  });

  describe("with --network", () => {
    it("uses the config's chainId without connecting when --nonce is given", async () => {
      // The port is closed: a connection would fail.
      const { hre } = await runtime({
        network: "remote",
        networks: { remote: { type: "http", url: "http://127.0.0.1:1", chainId: 11_155_111 } },
      });

      const { result } = await signAuth(hre, { nonce: "3" });

      assert.deepEqual(result, {
        chainId: "0xaa36a7",
        address: DELEGATE,
        nonce: "0x3",
        ...(await viemAuthorization(11_155_111, 3)),
      });
    });

    describe("against a node", () => {
      let node: RecordingNode | undefined;
      afterEach(async () => {
        await node?.server.close();
        node = undefined;
      });

      it("reads the chain and the key's pending nonce from the node", async () => {
        node = await startRecordingNode();
        const { hre } = await runtime({
          network: "remote",
          networks: { remote: { type: "http", url: node.url } },
        });

        const { result, warned } = await signAuth(hre, {});

        assert.deepEqual(result, {
          chainId: "0x7a69",
          address: DELEGATE,
          nonce: "0x0",
          ...(await viemAuthorization(31_337, 0)),
        });
        assert.equal(warned, "");
        assert.ok(node.methods.includes("eth_chainId"), node.methods.join(", "));
        assert.deepEqual(
          node.requests.filter((request) => request.method === "eth_getTransactionCount"),
          [
            {
              method: "eth_getTransactionCount",
              params: [HARDHAT_ACCOUNT_0.address, "pending"],
            },
          ],
        );
      });

      it("checks the node's chain against the config's when it reads the nonce", async () => {
        node = await startRecordingNode();
        const { hre, created } = await runtime({
          network: "remote",
          networks: { remote: { type: "http", url: node.url, chainId: 1 } },
        });

        await assertKmsError(
          signAuth(hre, {}),
          "the network config sets chainId 1, but the node reports 31337",
        );
        assert.equal(created.length, 0);
      });
    });

    it("adds one to the pending nonce with --self-broadcast, and says which nonce to send with", async () => {
      const plain = await withPendingCount("0x7");
      const self = await withPendingCount("0x7");

      const { result: forOther } = await signAuth(plain.hre, {});
      const { result: forSelf, warned } = await signAuth(self.hre, { selfBroadcast: true });

      assert.deepEqual(forOther, {
        chainId: "0x7a69",
        address: DELEGATE,
        nonce: "0x7",
        ...(await viemAuthorization(31_337, 7)),
      });
      assert.deepEqual(forSelf, {
        chainId: "0x7a69",
        address: DELEGATE,
        nonce: "0x8",
        ...(await viemAuthorization(31_337, 8)),
      });
      assert.match(
        warned,
        /\[hardhat-kms\] the authorization uses nonce 8: send it in a transaction from this key with nonce 7\n/,
      );
    });

    it("refuses a node answer that is not a nonce, and signs nothing", async () => {
      for (const count of ["7", 7, "0x", "0x07"]) {
        const { hre, created } = await withPendingCount(count);

        await assertKmsError(
          signAuth(hre, {}),
          "the node answered eth_getTransactionCount with something other than a nonce",
        );
        assert.equal(output.printed, "");
        assert.equal(
          created.find((adapter) => adapter.calls.signDigest > 0),
          undefined,
        );
      }
    });
  });

  it("refuses a signature that does not recover to the key, and prints nothing", async () => {
    const { hre, created } = await runtime({});
    const signed = mock.method(KmsSigner.prototype, "signDigest", async (digest: Uint8Array) => {
      const forged = secp256k1.Signature.fromBytes(
        secp256k1.sign(digest, hex(COW_ACCOUNT.secretKey), {
          prehash: false,
          format: "recovered",
        }),
        "recovered",
      );
      return { r: forged.r, s: forged.s, yParity: forged.recovery === 1 ? 1 : 0 } as const;
    });
    try {
      await assertKmsError(
        signAuth(hre, { chain: "1", nonce: "0" }),
        "the authorization does not recover to the key's address",
      );
      assert.equal(output.printed, "");
      assert.equal(created[0]?.closed, 1);
    } finally {
      signed.mock.restore();
    }
  });

  it("refuses a high-S signature, which EIP-7702 nodes skip", async () => {
    const { hre } = await runtime({});
    const order = secp256k1.Point.CURVE().n;
    const signed = mock.method(KmsSigner.prototype, "signDigest", async (digest: Uint8Array) => {
      const low = secp256k1.Signature.fromBytes(
        secp256k1.sign(digest, hex(HARDHAT_ACCOUNT_0.secretKey), {
          prehash: false,
          format: "recovered",
        }),
        "recovered",
      );
      // The high-S twin recovers to the same key with the other parity.
      return { r: low.r, s: order - low.s, yParity: low.recovery === 1 ? 0 : 1 } as const;
    });
    try {
      await assertKmsError(
        signAuth(hre, { chain: "1", nonce: "0" }),
        "the authorization does not recover to the key's address",
      );
      assert.equal(output.printed, "");
    } finally {
      signed.mock.restore();
    }
  });
});

describe("kms sign-auth on a Prague simulated network", () => {
  const delegated = `0xef0100${DELEGATE.slice(2).toLowerCase()}`;

  it("delegates the key's account when the same key sends the tuple, with --self-broadcast", async () => {
    assert.equal(await sendDelegation("deployer", { selfBroadcast: true }), delegated);
  });

  it("delegates the key's account when another account sends the tuple", async () => {
    assert.equal(await sendDelegation("sponsor", {}), delegated);
  });

  it("is accepted from one of Hardhat's own accounts, which the plugin does not sign for", async () => {
    assert.equal(await sendDelegation("hardhat", {}), delegated);
  });

  it("is skipped by the node when the key sends it without --self-broadcast", async () => {
    // The transaction uses nonce 0 first, so an authorization for nonce 0 no longer matches.
    assert.equal(await sendDelegation("deployer", {}), "0x");
  });
});
