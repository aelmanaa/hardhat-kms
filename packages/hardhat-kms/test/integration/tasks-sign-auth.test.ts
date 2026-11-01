import assert from "node:assert/strict";
import { after, afterEach, before, describe, it, mock } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { rpcAuthorizationList } from "@nomicfoundation/hardhat-zod-utils/rpc";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { HardhatPluginError } from "hardhat/plugins";
import type { NetworkUserConfig } from "hardhat/types/config";
import { privateKeyToAccount } from "viem/accounts";
import { recoverAuthorizationAddress } from "viem/utils";

import hardhatKms from "../../src/index.ts";
import { KmsSigner } from "../../src/internal/signer/kms-signer.ts";
import { ERC1967_IMPLEMENTATION_SLOT } from "../../src/internal/tasks/auth-review.ts";
import type { Terminal } from "../../src/internal/tasks/confirm.ts";
import { signAuthAction } from "../../src/internal/tasks/sign-auth.ts";
import type { KmsKeyUserConfig } from "../../src/types.ts";
import { type FakeAdapter, fakeAdapter } from "../helpers/fake-adapter.ts";
import { type RecordingNode, startRecordingNode } from "../helpers/recording-node.ts";
import { answering, NO_TERMINAL } from "../helpers/terminal.ts";
import { vaultKey } from "../helpers/vault-key.ts";
import { COW_ACCOUNT, HARDHAT_ACCOUNT_0 } from "../helpers/vectors.ts";

const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const ACCOUNT_0 = privateKeyToAccount(`0x${HARDHAT_ACCOUNT_0.secretKey}`);
/** The code to delegate to; any address works, code or not. */
const DELEGATE: `0x${string}` = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const ZERO: `0x${string}` = `0x${"0".repeat(40)}`;
/** Another contract address, for delegations and proxies. */
const OTHER = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";
const AUTHORITY = HARDHAT_ACCOUNT_0.address;
/** The code an account delegated to `address` has. */
const delegationTo = (address: string) => `0xef0100${address.slice(2).toLowerCase()}`;
const hashOf = (code: string) =>
  `0x${Buffer.from(keccak_256(Buffer.from(code.slice(2), "hex"))).toString("hex")}`;
const QUESTION_END = [
  "This delegates the account until another authorization replaces it.",
  "It is not undone if the transaction that carries it reverts.",
  "Anyone who holds the signature can submit it.",
  "Sign? [y/N] ",
];
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
  /** Replaces the `deployer` key's config, such as one with an address pin or allowedDelegates. */
  deployer?: KmsKeyUserConfig;
  /** Runs on each new connection, to set code, storage or nonces. */
  setup?: (request: (method: string, params: unknown[]) => Promise<unknown>) => Promise<unknown>;
}) {
  const hre = await createHardhatRuntimeEnvironment(
    {
      plugins: [hardhatKms],
      kms: {
        keys: { deployer: options.deployer ?? vaultKey("deployer"), sponsor: vaultKey("sponsor") },
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
  const { setup } = options;
  if (setup !== undefined) {
    hre.hooks.registerHandlers("network", {
      newConnection: async (context, next) => {
        const connection = await next(context);
        await setup(async (method, params) => {
          const answer: unknown = await connection.provider.request({ method, params });
          return answer;
        });
        return connection;
      },
    });
  }
  return { hre, created };
}

/** Every call the fake adapters received: public key and address reads, and signatures. */
const kmsCalls = (created: readonly FakeAdapter[]): number =>
  created.reduce(
    (total, { calls }) => total + calls.signDigest + calls.getPublicKey + calls.getAddress,
    0,
  );
const signatures = (created: readonly FakeAdapter[]): number =>
  created.reduce((total, { calls }) => total + calls.signDigest, 0);

type Runtime = Awaited<ReturnType<typeof runtime>>["hre"];

interface SignAuthArgs {
  key?: string;
  delegate?: string;
  chain?: string;
  nonce?: string;
  selfBroadcast?: boolean;
  force?: boolean;
  yes?: boolean;
}

/** What the last run printed, kept when the run fails. */
const output = { printed: "", warned: "", asked: "" };

/**
 * Runs `kms sign-auth` and returns its result and what it printed on stdout, stderr and the
 * terminal. By default the terminal answers `y`.
 */
async function signAuth(
  hre: Runtime,
  args: SignAuthArgs,
  terminal?: { terminal: Terminal; asked: () => string },
): Promise<{ result: unknown; printed: string; warned: string; asked: string }> {
  output.printed = "";
  output.warned = "";
  output.asked = "";
  const { terminal: used, asked } = terminal ?? answering("y\n");
  const write = mock.method(process.stdout, "write", (chunk: unknown) => {
    output.printed += String(chunk);
    return true;
  });
  const writeError = mock.method(process.stderr, "write", (chunk: unknown) => {
    output.warned += String(chunk);
    return true;
  });
  try {
    const result: unknown = await signAuthAction(() => used)(
      {
        key: "deployer",
        delegate: DELEGATE,
        chain: undefined,
        nonce: undefined,
        selfBroadcast: false,
        force: false,
        yes: false,
        ...args,
      },
      hre,
    );
    return { result, ...output, asked: asked() };
  } finally {
    output.asked = asked();
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

/**
 * A runtime whose `local` node answers `eth_getTransactionCount` with `count`, and
 * `eth_getCode` for {@link DELEGATE} with `code` when it is given.
 */
async function withPendingCount(count: unknown, code?: string) {
  const made = await runtime({ network: "local" });
  made.hre.hooks.registerHandlers("network", {
    onRequest: async (context, connection, request, next) => {
      if (request.method === "eth_getTransactionCount") {
        return { jsonrpc: "2.0", id: request.id, result: count };
      }
      const params: unknown = request.params;
      if (
        request.method === "eth_getCode" &&
        code !== undefined &&
        Array.isArray(params) &&
        params[0] === DELEGATE
      ) {
        return { jsonrpc: "2.0", id: request.id, result: code };
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

    const { result, printed, warned, asked } = await signAuth(hre, { chain: "1", nonce: "0" });

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
    // With --chain alone nothing is read, and the lines that need a node say so.
    assert.equal(
      asked,
      [
        "[hardhat-kms] EIP-7702 authorization",
        "  action      DELEGATE the account to the code at the delegate",
        `  account     ${HARDHAT_ACCOUNT_0.address} (key deployer)`,
        `  delegate    ${DELEGATE}`,
        "  chain       1 (from --chain)",
        "  nonce       0; account nonce not checked; self-sponsored: not known (--nonce)",
        "  delegate    code not checked",
        "  account     delegation not checked",
        "  node        none: with --chain, nothing is read from a node",
        "This delegates the account until another authorization replaces it.",
        "It is not undone if the transaction that carries it reverts.",
        "Anyone who holds the signature can submit it.",
        "Sign? [y/N] ",
      ].join("\n"),
    );
    // Standard error holds nothing else: the question went to the terminal.
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
        "an authorization for chain 0 is valid on every chain where the account's nonce matches. Pass --force to sign it anyway",
      );
      await assertKmsError(
        signAuth(hre, { chain: "0x0", nonce: "0" }),
        "Pass --force to sign it anyway",
      );
      assert.equal(created.length, 0);
    });

    it("is signed with --force after the question shows ALL CHAINS", async () => {
      const { hre } = await runtime({});

      const { result, asked } = await signAuth(hre, { chain: "0", nonce: "5", force: true });

      assert.deepEqual(result, {
        chainId: "0x0",
        address: DELEGATE,
        nonce: "0x5",
        ...(await viemAuthorization(0, 5)),
      });
      assert.ok(
        asked.includes(
          "\n  chain       ALL CHAINS (chain id 0): valid on every chain where the account's nonce is 5\n",
        ),
        asked,
      );
    });

    it("--force does not skip the question, and does not stand for --yes without a terminal", async () => {
      const { hre, created } = await runtime({});

      const { asked } = await signAuth(hre, { chain: "0", nonce: "5", force: true });
      assert.ok(asked.endsWith("Sign? [y/N] "), asked);
      await assertKmsError(
        signAuth(
          hre,
          { chain: "0", nonce: "5", force: true },
          { terminal: NO_TERMINAL, asked: () => "" },
        ),
        "without a terminal, kms sign-auth signs only with --yes",
      );
      assert.equal(signatures(created), 1);
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

  it("shows REVOKE for the zero address, which clears the delegation", async () => {
    const { hre } = await runtime({});

    const { result, asked } = await signAuth(hre, { chain: "1", nonce: "0", delegate: ZERO });

    assert.deepEqual(result, {
      chainId: "0x1",
      address: ZERO,
      nonce: "0x0",
      ...(await viemAuthorization(1, 0, ZERO)),
    });
    assert.equal(
      asked,
      [
        "[hardhat-kms] EIP-7702 authorization",
        "  action      REVOKE delegation (account becomes a plain EOA again)",
        `  account     ${HARDHAT_ACCOUNT_0.address} (key deployer)`,
        `  delegate    ${ZERO} (zero address)`,
        "  chain       1 (from --chain)",
        "  nonce       0; account nonce not checked; self-sponsored: not known (--nonce)",
        "  account     delegation not checked",
        "  node        none: with --chain, nothing is read from a node",
        "This clears the account's delegation until another authorization sets one.",
        "It is not undone if the transaction that carries it reverts.",
        "Anyone who holds the signature can submit it.",
        "Sign? [y/N] ",
      ].join("\n"),
    );
  });

  describe("with --network", () => {
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

        const { result, asked } = await signAuth(hre, {});

        assert.deepEqual(result, {
          chainId: "0x7a69",
          address: DELEGATE,
          nonce: "0x0",
          ...(await viemAuthorization(31_337, 0)),
        });
        assert.equal(
          asked,
          [
            "[hardhat-kms] EIP-7702 authorization",
            "  action      DELEGATE the account to the code at the delegate",
            `  account     ${HARDHAT_ACCOUNT_0.address} (key deployer)`,
            `  delegate    ${DELEGATE}`,
            "  chain       remote, 31337",
            "  nonce       0; account nonce now 0; self-sponsored: no",
            "  delegate    code none",
            "  account     now not delegated",
            "  node        network remote; its answers are not verified",
            "  warning     the delegate has no code on network remote: check that it is the address for this chain",
            "This delegates the account until another authorization replaces it.",
            "It is not undone if the transaction that carries it reverts.",
            "Anyone who holds the signature can submit it.",
            "Sign? [y/N] ",
          ].join("\n"),
        );
        assert.ok(node.methods.includes("eth_chainId"), node.methods.join(", "));
        // Each read once, the delegate's code included.
        assert.deepEqual(
          node.requests.filter((request) => request.method !== "eth_chainId"),
          [
            {
              method: "eth_getTransactionCount",
              params: [HARDHAT_ACCOUNT_0.address, "latest"],
            },
            {
              method: "eth_getTransactionCount",
              params: [HARDHAT_ACCOUNT_0.address, "pending"],
            },
            { method: "eth_getCode", params: [HARDHAT_ACCOUNT_0.address, "latest"] },
            { method: "eth_getCode", params: [DELEGATE, "latest"] },
            {
              method: "eth_getStorageAt",
              params: [DELEGATE, ERC1967_IMPLEMENTATION_SLOT, "latest"],
            },
          ],
        );
      });

      it("reads the node even with --nonce and a configured chainId", async () => {
        node = await startRecordingNode();
        const { hre } = await runtime({
          network: "remote",
          networks: { remote: { type: "http", url: node.url, chainId: 31_337 } },
        });

        const { result, asked } = await signAuth(hre, { nonce: "3" });

        assert.deepEqual(result, {
          chainId: "0x7a69",
          address: DELEGATE,
          nonce: "0x3",
          ...(await viemAuthorization(31_337, 3)),
        });
        assert.ok(
          asked.includes(
            "\n  nonce       3; account nonce now 0; self-sponsored: not known (--nonce)\n",
          ),
          asked,
        );
        assert.ok(node.methods.includes("eth_getStorageAt"), node.methods.join(", "));
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

    it("does not warn about a delegate that has code, or about the zero address", async () => {
      const withCode = await withPendingCount("0x0", "0x6000");
      const zero = await withPendingCount("0x0");

      const { asked } = await signAuth(withCode.hre, {});
      const { asked: zeroAsked } = await signAuth(zero.hre, { delegate: ZERO });

      assert.doesNotMatch(asked, /warning/);
      assert.match(asked, /\n {2}delegate {4}code 2 bytes, keccak 0x[0-9a-f]{64}\n/);
      assert.match(asked, /\n {2}chain {7}local, 31337\n/);
      assert.doesNotMatch(zeroAsked, /warning/);
      assert.match(zeroAsked, /REVOKE delegation/);
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

describe("kms sign-auth: the question", () => {
  it("shows every field read from the node, with the allowlist's label and each warning", async () => {
    const code = "0x60006000";
    const { hre } = await runtime({
      network: "local",
      deployer: {
        ...vaultKey("deployer"),
        allowedDelegates: [{ address: DELEGATE, chains: "all", label: "batcher" }],
      },
      setup: async (request) => {
        await request("hardhat_setCode", [DELEGATE, code]);
        await request("hardhat_setStorageAt", [
          DELEGATE,
          ERC1967_IMPLEMENTATION_SLOT,
          `0x${OTHER.slice(2).toLowerCase().padStart(64, "0")}`,
        ]);
        await request("hardhat_setCode", [AUTHORITY, delegationTo(OTHER)]);
      },
    });

    const { asked, printed } = await signAuth(hre, { nonce: "9" });

    assert.equal(
      asked,
      [
        "[hardhat-kms] EIP-7702 authorization",
        "  action      DELEGATE the account to the code at the delegate",
        `  account     ${AUTHORITY} (key deployer)`,
        `  delegate    batcher ${DELEGATE}`,
        "  chain       local, 31337",
        "  nonce       9; account nonce now 0; self-sponsored: not known (--nonce)",
        `  delegate    code 4 bytes, keccak ${hashOf(code)}`,
        `  account     now delegated to ${OTHER}`,
        "  node        network local; its answers are not verified",
        "  warning     nonce 9 is ahead of the account's next nonce 0: the signature stays valid until the account reaches it, and anyone who holds it can submit it then",
        `  warning     the account is delegated to ${OTHER} now: storage it wrote stays, and the new delegate reads and writes the same slots`,
        `  warning     the delegate's ERC-1967 implementation slot points to ${OTHER}: it looks like a proxy, so its code can change after you sign`,
        ...QUESTION_END,
      ].join("\n"),
    );
    assert.equal(tupleOf(printed).nonce, "0x9");
  });

  it("warns about each case on its own, and still asks", async () => {
    const cases: {
      name: string;
      args: SignAuthArgs;
      setup: (request: (method: string, params: unknown[]) => Promise<unknown>) => Promise<unknown>;
      warning: string;
    }[] = [
      {
        name: "a nonce ahead of the next one",
        args: { nonce: "1" },
        setup: async (request) => await request("hardhat_setCode", [DELEGATE, "0x6000"]),
        warning: "nonce 1 is ahead of the account's next nonce 0",
      },
      {
        name: "a re-delegation",
        args: {},
        setup: async (request) => {
          await request("hardhat_setCode", [DELEGATE, "0x6000"]);
          await request("hardhat_setCode", [AUTHORITY, delegationTo(OTHER)]);
        },
        warning: `the account is delegated to ${OTHER} now`,
      },
      {
        name: "an ERC-1967 slot",
        args: {},
        setup: async (request) => {
          await request("hardhat_setCode", [DELEGATE, "0x6000"]);
          await request("hardhat_setStorageAt", [
            DELEGATE,
            ERC1967_IMPLEMENTATION_SLOT,
            `0x${"0".repeat(63)}1`,
          ]);
        },
        warning:
          "the delegate's ERC-1967 implementation slot points to 0x0000000000000000000000000000000000000001",
      },
      {
        name: "a delegate without code",
        args: {},
        setup: async () => undefined,
        warning: "the delegate has no code on network local",
      },
    ];
    for (const { name, args, setup, warning } of cases) {
      const { hre } = await runtime({ network: "local", setup });

      const { asked } = await signAuth(hre, args);

      const warnings = asked.split("\n").filter((line) => line.startsWith("  warning"));
      assert.equal(warnings.length, 1, `${name}: ${asked}`);
      assert.ok(warnings[0]?.startsWith(`  warning     ${warning}`), `${name}: ${asked}`);
      assert.ok(asked.endsWith("Sign? [y/N] "), name);
    }
  });

  it("does not warn when the account is already delegated to the same delegate, or for --self-broadcast's nonce", async () => {
    const { hre } = await runtime({
      network: "local",
      setup: async (request) => {
        await request("hardhat_setCode", [DELEGATE, "0x6000"]);
        await request("hardhat_setCode", [AUTHORITY, delegationTo(DELEGATE)]);
      },
    });

    const { asked } = await signAuth(hre, { selfBroadcast: true });

    assert.doesNotMatch(asked, /warning/);
    assert.match(asked, /\n {2}nonce {7}1; account nonce now 0; self-sponsored: yes\n/);
    assert.ok(asked.includes(`\n  account     now delegated to ${DELEGATE}\n`), asked);
  });

  it("makes no KMS call and fails on n, an empty line, another word or closed input", async () => {
    for (const answer of ["n\n", "\n", "no\n", "sure\n", undefined]) {
      const { hre, created } = await runtime({
        deployer: vaultKey("deployer", AUTHORITY),
      });
      const terminal = answering(answer);

      await assertKmsError(
        signAuth(hre, { chain: "1", nonce: "0" }, terminal),
        "kms sign-auth: the authorization was not signed: the question was not answered with y or yes",
      );

      assert.ok(terminal.asked().includes(`  account     ${AUTHORITY} (key deployer)\n`));
      assert.equal(output.printed, "");
      // The pin is shown, so not even the public key is read.
      assert.equal(kmsCalls(created), 0, JSON.stringify(answer));
    }
  });

  it("signs nothing when a --network question is declined", async () => {
    const { hre, created } = await runtime({ network: "local" });

    await assertKmsError(signAuth(hre, {}, answering("n\n")), "the authorization was not signed");

    assert.equal(output.printed, "");
    assert.equal(signatures(created), 0);
  });

  it("signs on y or yes, in any case", async () => {
    for (const answer of ["y\n", "YES\n", " yes \n"]) {
      const { hre } = await runtime({});
      const { result } = await signAuth(hre, { chain: "1", nonce: "0" }, answering(answer));
      assert.deepEqual(result, {
        chainId: "0x1",
        address: DELEGATE,
        nonce: "0x0",
        ...(await viemAuthorization(1, 0)),
      });
    }
  });

  it("asks inside hre.interruptions.uninterrupted", async () => {
    const { hre } = await runtime({});
    let inside = false;
    let insideWhenAsked: boolean | undefined;
    const uninterrupted = mock.method(
      hre.interruptions,
      "uninterrupted",
      async <ReturnT>(task: () => ReturnT): Promise<Awaited<ReturnT>> => {
        inside = true;
        try {
          return await task();
        } finally {
          inside = false;
        }
      },
    );
    try {
      await signAuth(
        hre,
        { chain: "1", nonce: "0" },
        answering("y\n", () => {
          insideWhenAsked = inside;
        }),
      );
    } finally {
      uninterrupted.mock.restore();
    }
    assert.equal(uninterrupted.mock.callCount(), 1);
    assert.equal(insideWhenAsked, true);
  });

  it("shows the chain-0 and zero-address lines before the KMS signs, for a key without a pin", async () => {
    const { hre, created } = await runtime({});
    // How many signatures the KMS had made when each prompt was shown.
    const atPrompt: number[] = [];
    const revoke = answering("y\n", () => atPrompt.push(signatures(created)));
    const chainZero = answering("y\n", () => atPrompt.push(signatures(created)));

    await signAuth(hre, { chain: "1", nonce: "0", delegate: ZERO }, revoke);
    await signAuth(hre, { chain: "0", nonce: "0", force: true }, chainZero);

    assert.deepEqual(atPrompt, [0, 1]);
    assert.equal(signatures(created), 2);
    assert.match(revoke.asked(), /REVOKE delegation \(account becomes a plain EOA again\)/);
    assert.match(chainZero.asked(), /ALL CHAINS \(chain id 0\)/);
  });
});

describe("kms sign-auth without a terminal", () => {
  const NONE = { terminal: NO_TERMINAL, asked: () => "" };
  const listed = {
    ...vaultKey("deployer"),
    allowedDelegates: [
      { address: DELEGATE, chains: "all" as const, label: "batcher" },
      { address: OTHER, chains: [10] },
      { address: COW_ACCOUNT.address, chains: "all" as const, codeHash: hashOf("0x6000") },
    ],
  };

  it("refuses without --yes, before any KMS call, even for a listed delegate or the zero address", async () => {
    for (const [deployer, delegate] of [
      [listed, DELEGATE],
      [listed, ZERO],
      [vaultKey("deployer"), ZERO],
      [vaultKey("deployer"), DELEGATE],
    ] as const) {
      const { hre, created } = await runtime({ deployer });
      await assertKmsError(
        signAuth(hre, { chain: "1", nonce: "0", delegate, force: true }, NONE),
        "kms sign-auth: without a terminal, kms sign-auth signs only with --yes, for a delegate in the key's allowedDelegates or the zero address. --yes was not passed. Nothing was signed",
      );
      assert.equal(created.length, 0);
    }
  });

  it("refuses --yes for a key without allowedDelegates, before any KMS call or connection", async () => {
    const { hre, created } = await runtime({ network: "local" });
    const connect = mock.method(hre.network, "create");
    try {
      await assertKmsError(
        signAuth(hre, { yes: true }, NONE),
        'kms sign-auth: without a terminal, --yes signs only for a delegate in the key\'s allowedDelegates or the zero address. Key "deployer" has no allowedDelegates. Nothing was signed',
      );
      assert.equal(connect.mock.callCount(), 0);
    } finally {
      connect.mock.restore();
    }
    assert.equal(created.length, 0);
  });

  it("refuses --yes for an unlisted, wrong-chain or pin-mismatched delegate, with or without a terminal", async () => {
    for (const terminal of [() => NONE, () => answering("y\n")]) {
      const { hre, created } = await runtime({ deployer: listed });
      await assertKmsError(
        signAuth(
          hre,
          { chain: "1", nonce: "0", delegate: HARDHAT_ACCOUNT_1, yes: true },
          terminal(),
        ),
        `may not delegate to ${HARDHAT_ACCOUNT_1} on chain 1`,
      );
      await assertKmsError(
        signAuth(hre, { chain: "1", nonce: "0", delegate: OTHER, yes: true }, terminal()),
        `may not delegate to ${OTHER} on chain 1`,
      );
      assert.equal(created.length, 0);
      const onNetwork = await runtime({
        network: "local",
        deployer: listed,
        setup: async (request) => await request("hardhat_setCode", [COW_ACCOUNT.address, "0x6001"]),
      });
      await assertKmsError(
        signAuth(onNetwork.hre, { delegate: COW_ACCOUNT.address, yes: true }, terminal()),
        `the code of delegate ${COW_ACCOUNT.address} on chain 31337 has hash ${hashOf("0x6001")}`,
      );
      assert.equal(signatures(onNetwork.created), 0);
    }
  });

  it("signs with --yes for a listed delegate and for the zero address, and prints the summary on stderr", async () => {
    const { hre } = await runtime({ network: "local", deployer: listed });
    const { result, warned } = await signAuth(hre, { yes: true }, NONE);
    assert.deepEqual(result, {
      chainId: "0x7a69",
      address: DELEGATE,
      nonce: "0x0",
      ...(await viemAuthorization(31_337, 0)),
    });
    assert.ok(warned.startsWith("[hardhat-kms] EIP-7702 authorization\n"), warned);
    assert.ok(warned.includes(`\n  delegate    batcher ${DELEGATE}\n`), warned);
    assert.doesNotMatch(warned, /Sign\?/);

    // A key without allowedDelegates can still revoke.
    const plain = await runtime({});
    const revoke = await signAuth(
      plain.hre,
      { chain: "1", nonce: "0", delegate: ZERO, yes: true },
      NONE,
    );
    assert.deepEqual(revoke.result, {
      chainId: "0x1",
      address: ZERO,
      nonce: "0x0",
      ...(await viemAuthorization(1, 0, ZERO)),
    });
    assert.match(revoke.warned, /REVOKE delegation/);
  });

  it("at a terminal, --yes skips the question only for a listed delegate or the zero address", async () => {
    const withList = await runtime({ deployer: listed });
    const skipped = answering("n\n");
    await signAuth(withList.hre, { chain: "1", nonce: "0", yes: true }, skipped);
    assert.equal(skipped.asked(), "");

    const plain = await runtime({});
    const zero = answering("n\n");
    await signAuth(plain.hre, { chain: "1", nonce: "0", delegate: ZERO, yes: true }, zero);
    assert.equal(zero.asked(), "");

    const asked = answering("y\n");
    const { warned } = await signAuth(plain.hre, { chain: "1", nonce: "0", yes: true }, asked);
    assert.ok(asked.asked().endsWith("Sign? [y/N] "));
    assert.equal(
      warned,
      '[hardhat-kms] --yes does not skip the question: key "deployer" has no allowedDelegates\n',
    );
  });
});

describe("kms sign-auth refuses authorizations that cannot apply", () => {
  it("refuses a precompile delegate before any KMS call", async () => {
    for (const delegate of [
      "0x0000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000011",
      "0x0000000000000000000000000000000000000100",
      "0x00000000000000000000000000000000000001fF",
    ]) {
      const { hre, created } = await runtime({});
      await assertKmsError(
        signAuth(
          hre,
          { chain: "1", nonce: "0", delegate },
          { terminal: NO_TERMINAL, asked: () => "" },
        ),
        `kms sign-auth: the delegate ${delegate} is in the reserved precompile range 0x01 to 0x1ff: every call to the account would succeed and do nothing. Nothing was signed`,
      );
      assert.equal(created.length, 0);
    }
    // The first address above the range signs.
    const { hre } = await runtime({});
    const { printed } = await signAuth(hre, {
      chain: "1",
      nonce: "0",
      delegate: "0x0000000000000000000000000000000000000200",
    });
    assert.equal(tupleOf(printed).address, "0x0000000000000000000000000000000000000200");
  });

  it("refuses a nonce the account has passed", async () => {
    const { hre, created } = await runtime({
      network: "local",
      setup: async (request) => await request("hardhat_setNonce", [AUTHORITY, "0x5"]),
    });

    await assertKmsError(
      signAuth(hre, { nonce: "4" }),
      "kms sign-auth: the nonce 4 is below the account's nonce 5 on network local, so the authorization could never apply. Nothing was signed",
    );
    assert.equal(output.asked, "");
    assert.equal(output.printed, "");
    assert.equal(signatures(created), 0);
    // The current nonce signs.
    const { printed } = await signAuth(hre, { nonce: "5" });
    assert.equal(tupleOf(printed).nonce, "0x5");
  });

  it("refuses a delegate that is itself delegated", async () => {
    const { hre, created } = await runtime({
      network: "local",
      setup: async (request) => await request("hardhat_setCode", [DELEGATE, delegationTo(OTHER)]),
    });

    await assertKmsError(
      signAuth(hre, {}),
      `kms sign-auth: the delegate ${DELEGATE} is itself a delegated account on network local: its code starts with 0xef0100. Clients follow one delegation only, so every call to this account would fail. Nothing was signed`,
    );
    assert.equal(output.asked, "");
    assert.equal(signatures(created), 0);
  });

  it("refuses an account with contract code that is not a delegation", async () => {
    const { hre, created } = await runtime({
      network: "local",
      setup: async (request) => await request("hardhat_setCode", [AUTHORITY, "0x6000"]),
    });

    await assertKmsError(
      signAuth(hre, {}),
      `kms sign-auth: the account ${AUTHORITY} has 2 bytes of contract code on network local, which is not a delegation, so nodes would skip the authorization. Nothing was signed`,
    );
    assert.equal(output.asked, "");
    assert.equal(signatures(created), 0);
  });

  it("refuses node answers that are not code or a storage word", async () => {
    for (const [method, answer, message] of [
      ["eth_getCode", "0x6", "the node answered eth_getCode with something other than hex data"],
      ["eth_getCode", 7, "the node answered eth_getCode with something other than hex data"],
      [
        "eth_getStorageAt",
        `0x${"0".repeat(65)}`,
        "the node answered eth_getStorageAt with something other than a 32-byte word",
      ],
      [
        "eth_getStorageAt",
        null,
        "the node answered eth_getStorageAt with something other than a 32-byte word",
      ],
    ] as const) {
      const { hre, created } = await runtime({ network: "local" });
      hre.hooks.registerHandlers("network", {
        onRequest: async (context, connection, request, next) =>
          request.method === method
            ? { jsonrpc: "2.0", id: request.id, result: answer }
            : await next(context, connection, request),
      });
      await assertKmsError(signAuth(hre, {}), message);
      assert.equal(signatures(created), 0);
    }
  });

  it("reads a short storage word as a number", async () => {
    const { hre } = await runtime({ network: "local" });
    hre.hooks.registerHandlers("network", {
      onRequest: async (context, connection, request, next) =>
        request.method === "eth_getStorageAt"
          ? { jsonrpc: "2.0", id: request.id, result: "0x" }
          : await next(context, connection, request),
    });
    const { asked } = await signAuth(hre, {});
    assert.doesNotMatch(asked, /ERC-1967/);
  });
});

/** The node {@link withAnswers} connects to; started by the suite that uses it. */
let answersNode: RecordingNode | undefined;

/**
 * A runtime on `remote`, an HTTP network without a `chainId` in its config, whose answers are the
 * values `answer` returns, and the node's for the rest. The chain comes from the node.
 */
async function withAnswers(
  answer: (method: string, params: readonly unknown[]) => unknown,
  deployer?: KmsKeyUserConfig,
) {
  assert.ok(answersNode !== undefined);
  const made = await runtime({
    network: "remote",
    networks: { remote: { type: "http", url: answersNode.url } },
    ...(deployer === undefined ? {} : { deployer }),
  });
  const requests: { method: string; params: readonly unknown[] }[] = [];
  made.hre.hooks.registerHandlers("network", {
    onRequest: async (context, connection, request, next) => {
      const params: unknown = request.params;
      const list: readonly unknown[] = Array.isArray(params) ? params : [];
      requests.push({ method: request.method, params: list });
      const result = answer(request.method, list);
      return result === undefined
        ? await next(context, connection, request)
        : { jsonrpc: "2.0", id: request.id, result };
    },
  });
  return { ...made, requests };
}

/** Different `latest` and `pending` counts. */
const latestThreePendingFive = (method: string, params: readonly unknown[]) =>
  method === "eth_getTransactionCount" ? (params[1] === "latest" ? "0x3" : "0x5") : undefined;

describe("kms sign-auth: node answers", () => {
  before(async () => {
    answersNode = await startRecordingNode();
  });
  after(async () => {
    await answersNode?.server.close();
    answersNode = undefined;
  });

  it("refuses a nonce answer of 2^64 or more, which would stretch the question", async () => {
    for (const tag of ["latest", "pending"]) {
      const { hre, created } = await withAnswers((method, params) =>
        method === "eth_getTransactionCount" && params[1] === tag
          ? `0x1${"0".repeat(16)}`
          : undefined,
      );
      await assertKmsError(
        signAuth(hre, {}),
        "the node answered eth_getTransactionCount with something other than a nonce",
      );
      assert.equal(output.asked, "");
      assert.equal(signatures(created), 0);
    }
    // The largest account nonce passes.
    const { hre } = await withAnswers((method) =>
      method === "eth_getTransactionCount" ? `0x${"f".repeat(16)}` : undefined,
    );
    await assertKmsError(signAuth(hre, {}), "EIP-7702 needs one below 2^64 - 1");
  });

  it("refuses a node chain id of 2^256 or more, before any sign request", async () => {
    const { hre, created } = await withAnswers((method) =>
      method === "eth_chainId" ? `0x1${"0".repeat(64)}` : undefined,
    );
    await assertKmsError(
      signAuth(hre, { nonce: "0" }),
      "kms sign-auth: the node reported a chain id that does not fit in 256 bits, so no authorization can name it. Nothing was signed",
    );
    assert.equal(created.length, 0);
  });

  it("refuses chain 0 from a node without a configured chainId, even for a listed delegate with --yes", async () => {
    const { hre, created } = await withAnswers(
      (method) => (method === "eth_chainId" ? "0x0" : undefined),
      {
        ...vaultKey("deployer"),
        allowedDelegates: [{ address: DELEGATE, chains: "all" }],
      },
    );
    for (const terminal of [{ terminal: NO_TERMINAL, asked: () => "" }, answering("y\n")]) {
      await assertKmsError(
        signAuth(hre, { yes: true }, terminal),
        "Pass --force to sign it anyway",
      );
    }
    assert.equal(signatures(created), 0);
  });

  it("signs the pending nonce, not the latest one, when they differ, and adds one with --self-broadcast", async () => {
    const plain = await withAnswers(latestThreePendingFive);
    const self = await withAnswers(latestThreePendingFive);

    const { printed, asked } = await signAuth(plain.hre, {});
    assert.equal(tupleOf(printed).nonce, "0x5");
    assert.ok(
      asked.includes("\n  nonce       5; account nonce now 3 (5 pending); self-sponsored: no\n"),
      asked,
    );
    const forSelf = await signAuth(self.hre, { selfBroadcast: true });
    assert.equal(tupleOf(forSelf.printed).nonce, "0x6");
  });

  it("warns when --nonce is below the pending count", async () => {
    const { hre } = await withAnswers(latestThreePendingFive);
    const { asked } = await signAuth(hre, { nonce: "4" });
    assert.ok(
      asked.includes(
        "\n  warning     nonce 4 is below the account's pending count 5: a pending transaction will likely use it first, and the authorization then cannot apply\n",
      ),
      asked,
    );
  });

  it("reads a pinned delegate's code once, and shows the hash it checked", async () => {
    const code = "0x60806040fe";
    const hash = hashOf(code);
    let reads = 0;
    const { hre, requests } = await withAnswers(
      (method, params) => {
        if (method === "eth_getCode" && params[0] === DELEGATE) {
          reads += 1;
          // A node that changes its answer: only the first read may be used.
          return reads === 1 ? code : "0x6000";
        }
        return undefined;
      },
      {
        ...vaultKey("deployer"),
        allowedDelegates: [{ address: DELEGATE, chains: "all", codeHash: hash }],
      },
    );

    const { asked } = await signAuth(hre, { yes: true }, answering("y\n"));

    assert.equal(
      requests.filter(
        (request) => request.method === "eth_getCode" && request.params[0] === DELEGATE,
      ).length,
      1,
    );
    assert.equal(asked, "");
    assert.ok(
      output.warned.includes(`\n  delegate    code 5 bytes, keccak ${hash}\n`),
      output.warned,
    );
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

  it("is refused before signing when the key sends it without --self-broadcast (#435)", async () => {
    // The transaction uses nonce 0 first, so an authorization for nonce 0 no longer matches.
    await assertKmsError(
      sendDelegation("deployer", {}),
      "eth_sendTransaction: authorizationList[0] is signed by the sender for nonce 0, but the final transaction requires nonce 1",
    );
  });
});
