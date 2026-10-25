// A key's allowedDelegates (#562) on a real Hardhat runtime and a Prague simulated network, in
// each path that signs or carries the key's EIP-7702 authorization: `kms sign-auth`, a library
// account's signAuthorization, and a send's self-authorizations (eth_sendTransaction,
// eth_signTransaction and `kms sign-tx`). Pinned code is set with hardhat_setCode.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";

import { keccak_256 } from "@noble/hashes/sha3.js";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { HardhatPluginError } from "hardhat/plugins";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";

import hardhatKms from "../../src/index.ts";
import { signAuthAction } from "../../src/internal/tasks/sign-auth.ts";
import type { AwsKmsKeyUserConfig, KmsAllowedDelegateUserConfig } from "../../src/types.ts";
import { type FakeAdapter, fakeAdapter } from "../helpers/fake-adapter.ts";
import { type FakeTxAdapter, fakeTxAdapter } from "../helpers/fake-tx-adapter.ts";
import { answering } from "../helpers/terminal.ts";
import { vaultKey } from "../helpers/vault-key.ts";
import { COW_ACCOUNT, HARDHAT_ACCOUNT_0 } from "../helpers/vectors.ts";

const ACCOUNT_0 = privateKeyToAccount(`0x${HARDHAT_ACCOUNT_0.secretKey}`);
const COW = privateKeyToAccount(`0x${COW_ACCOUNT.secretKey}`);
const CHAIN_ID = 31337;
/** Listed for every chain. */
const SIMPLE = "0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9";
/** Listed for chain 1 and the simulated chain only. */
const MAV2 = "0x77021100bD87b7008E5E1989d0eB38555d0d0000";
/** Listed for every chain with a code hash; the network hook gives it CODE. */
const PINNED = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
/** Listed with a code hash, and no code on the network. */
const PINNED_EMPTY = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
/** Listed with a code hash its code does not have. */
const PINNED_OTHER = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";
/** In no entry. */
const UNLISTED = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ZERO = "0x0000000000000000000000000000000000000000";
const CODE = "0x60806040fe";
const hashOf = (code: string) =>
  `0x${Buffer.from(keccak_256(Buffer.from(code.slice(2), "hex"))).toString("hex")}`;

const ALLOWED: KmsAllowedDelegateUserConfig[] = [
  { address: SIMPLE, chains: "all", label: "Simple7702Account" },
  { address: MAV2, chains: [1, CHAIN_ID], label: "Modular Account v2" },
  { address: PINNED, chains: "all", label: "batcher", codeHash: hashOf(CODE) },
  { address: PINNED_EMPTY, chains: [CHAIN_ID], codeHash: hashOf(CODE) },
  { address: PINNED_OTHER, chains: [CHAIN_ID], codeHash: hashOf("0x6000") },
];

let scratch: string;
before(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "hardhat-kms-delegates-"));
});
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * A runtime whose `deployer` key is Hardhat's first account, with {@link ALLOWED}, and whose
 * `sponsor` key has no list. Both are KMS accounts of the Prague `local` network, and every new
 * connection gets {@link CODE} at {@link PINNED} and {@link PINNED_OTHER}. With `kms`, the config
 * also has `listed` and `pinned` keys: `listedKey` changes `listed`, and `awsRegion: false` drops
 * `kms.defaults.aws.region`, so a `--kms aws` key has no region of its own.
 */
async function runtime(
  network?: string,
  options: {
    keeps?: boolean;
    kms?: string;
    listedKey?: Partial<AwsKmsKeyUserConfig>;
    awsRegion?: false;
  } = {},
) {
  const hre = await createHardhatRuntimeEnvironment(
    {
      plugins: [hardhatKms],
      kms: {
        keys: {
          deployer: { ...vaultKey("deployer"), allowedDelegates: ALLOWED },
          sponsor: vaultKey("sponsor"),
          ...(options.kms === undefined
            ? {}
            : {
                // The same AWS key as `--kms aws` with AWS_KMS_KEY_ID=alias/listed, by its id.
                listed: {
                  provider: "aws",
                  keyId: "alias/listed",
                  allowedDelegates: ALLOWED,
                  ...options.listedKey,
                },
                // A key with the deployer's address pin, which no id can match.
                pinned: {
                  ...vaultKey("pinned", ACCOUNT_0.address),
                  allowedDelegates: ALLOWED,
                },
              }),
        },
        defaults: options.awsRegion === false ? {} : { aws: { region: "eu-west-1" } },
        simulatedBalance: 10n ** 18n,
      },
      networks: {
        local: { type: "edr-simulated", hardfork: "prague", kmsAccounts: ["deployer", "sponsor"] },
        // No chainId and no node: a refusal on it must come before any connection.
        remote: { type: "http", url: "http://127.0.0.1:9", kmsAccounts: ["deployer"] },
        optimism: {
          type: "http",
          url: "http://127.0.0.1:9",
          chainId: 10,
          kmsAccounts: ["deployer"],
        },
      },
    },
    {
      ...(network === undefined ? {} : { network }),
      ...(options.kms === undefined ? {} : { kms: options.kms }),
    },
  );
  const created: FakeAdapter[] = [];
  const keepers: FakeTxAdapter[] = [];
  const secretKeys: Record<string, string> = {
    deployer: HARDHAT_ACCOUNT_0.secretKey,
    sponsor: COW_ACCOUNT.secretKey,
    AWS_KMS_KEY_ID: HARDHAT_ACCOUNT_0.secretKey,
  };
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async (context, key, next) => {
      const secretKey = secretKeys[key.name];
      if (secretKey === undefined) {
        return await next(context, key);
      }
      const bytes = new Uint8Array(Buffer.from(secretKey, "hex"));
      if (options.keeps === true) {
        // A provider that keeps what it signs, as Turnkey does: eth_signTransaction then signs
        // under the send lock (#537).
        const keeping = Object.assign(fakeTxAdapter({ secretKey: bytes, behaviour: "honest" }), {
          signTransactionOutlivesAbort: true,
        });
        keepers.push(keeping);
        return keeping;
      }
      const adapter = fakeAdapter({ secretKey: bytes });
      created.push(adapter);
      return adapter;
    },
  });
  hre.hooks.registerHandlers("network", {
    newConnection: async (context, next) => {
      const connection = await next(context);
      for (const address of [PINNED, PINNED_OTHER]) {
        await connection.provider.request({ method: "hardhat_setCode", params: [address, CODE] });
      }
      return connection;
    },
  });
  const signatures = (): number =>
    created.reduce((total, adapter) => total + adapter.calls.signDigest, 0) +
    keepers.reduce(
      (total, adapter) => total + adapter.calls.signDigest + adapter.calls.signTransaction,
      0,
    );
  return { hre, created, signatures };
}

async function assertRefused(promise: Promise<unknown>, includes: string | RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HardhatPluginError, String(error));
    if (typeof includes === "string") {
      assert.ok(
        error.message.includes(includes),
        `"${error.message}" should include "${includes}"`,
      );
    } else {
      assert.match(error.message, includes);
    }
    return true;
  });
}

/** The `address` of a printed tuple. */
function delegateOf(tuple: unknown): unknown {
  assert.ok(typeof tuple === "object" && tuple !== null && "address" in tuple);
  return tuple.address;
}

interface SignAuthArgs {
  key?: string;
  delegate: string;
  chain?: string;
  nonce?: string;
  force?: boolean;
}

/**
 * Runs `kms sign-auth deployer --yes` at a terminal that answers `y`, with standard output and
 * error captured. `--yes` skips the question for a listed delegate or the zero address (#563), and
 * a key without a list, such as a `--kms` key, is asked and answers `y`, so the list and the
 * `--kms` checks are what these tests see. `--yes` never overrides the list.
 */
async function signAuth(
  hre: HardhatRuntimeEnvironment,
  args: SignAuthArgs,
): Promise<{ result: unknown; printed: string; warned: string }> {
  const output = { printed: "", warned: "" };
  const write = mock.method(process.stdout, "write", (chunk: unknown) => {
    output.printed += String(chunk);
    return true;
  });
  const writeError = mock.method(process.stderr, "write", (chunk: unknown) => {
    output.warned += String(chunk);
    return true;
  });
  try {
    const result: unknown = await signAuthAction(() => answering("y\n").terminal)(
      {
        key: "deployer",
        chain: undefined,
        nonce: undefined,
        selfBroadcast: false,
        force: false,
        yes: true,
        ...args,
      },
      hre,
    );
    return { result, ...output };
  } finally {
    write.mock.restore();
    writeError.mock.restore();
  }
}

describe("allowedDelegates: kms sign-auth", () => {
  it("refuses an unlisted delegate with --chain and with --network, before any KMS call", async () => {
    const plain = await runtime();
    await assertRefused(
      signAuth(plain.hre, { delegate: UNLISTED, chain: "1", nonce: "0" }),
      `kms sign-auth: key deployer may not delegate to ${UNLISTED} on chain 1: no entry of its allowedDelegates allows that delegate on that chain. Nothing was signed`,
    );
    // The config gives the chain: matched against it before connecting.
    const onNetwork = await runtime("local");
    await assertRefused(
      signAuth(onNetwork.hre, { delegate: UNLISTED }),
      `kms sign-auth: key deployer may not delegate to ${UNLISTED} on chain 31337: no entry of its allowedDelegates allows that delegate on that chain. Nothing was signed`,
    );
    // A delegate listed for other chains than the config's, with no node to reach.
    const optimism = await runtime("optimism");
    await assertRefused(
      signAuth(optimism.hre, { delegate: MAV2 }),
      `kms sign-auth: key deployer may not delegate to ${MAV2} on chain 10:`,
    );
    // No chainId in the config: a delegate no entry names is refused before connecting.
    const remote = await runtime("remote");
    await assertRefused(
      signAuth(remote.hre, { delegate: UNLISTED }),
      `kms sign-auth: key deployer may not delegate to ${UNLISTED} on network remote: no entry of its allowedDelegates names that delegate. Nothing was signed`,
    );
    // Not even the public key: the delegate is refused before the connection or the signer opens.
    assert.equal(
      plain.created.length +
        onNetwork.created.length +
        optimism.created.length +
        remote.created.length,
      0,
    );
  });

  it("refuses a delegate listed for another chain, after reading the network's chain", async () => {
    const { hre, signatures } = await runtime();
    await assertRefused(
      signAuth(hre, { delegate: MAV2, chain: "10", nonce: "0" }),
      `may not delegate to ${MAV2} on chain 10`,
    );
    assert.equal(signatures(), 0);
  });

  it("refuses chain 0 for a delegate listed for chain 1, and --force does not override it", async () => {
    const { hre, created } = await runtime();
    await assertRefused(
      signAuth(hre, { delegate: MAV2, chain: "0", nonce: "0", force: true }),
      `kms sign-auth: key deployer may not delegate to ${MAV2} on chain 0, which is every chain: only an allowedDelegates entry with chains: "all" allows a chain-0 authorization. Nothing was signed`,
    );
    await assertRefused(
      signAuth(hre, { delegate: UNLISTED, chain: "1", nonce: "0", force: true }),
      "may not delegate to",
    );
    assert.equal(created.length, 0);
    const { result } = await signAuth(hre, {
      delegate: SIMPLE,
      chain: "0",
      nonce: "0",
      force: true,
    });
    assert.equal(delegateOf(result), SIMPLE);
  });

  it("signs a listed delegate and names its label", async () => {
    const { hre } = await runtime("local");
    const { result, warned } = await signAuth(hre, { delegate: MAV2 });
    const signed = await ACCOUNT_0.signAuthorization({
      address: MAV2,
      chainId: CHAIN_ID,
      nonce: 0,
    });
    assert.deepEqual(result, {
      chainId: "0x7a69",
      address: MAV2,
      nonce: "0x0",
      yParity: `0x${signed.yParity ?? 0}`,
      r: signed.r,
      s: signed.s,
    });
    assert.ok(warned.includes(`\n  delegate    Modular Account v2 ${MAV2}\n`), warned);
  });

  it("signs the zero address with --chain and with --network", async () => {
    const { hre } = await runtime();
    const { result } = await signAuth(hre, { delegate: ZERO, chain: "1", nonce: "0" });
    assert.equal(delegateOf(result), ZERO);
    const onNetwork = await runtime("local");
    const revoke = await signAuth(onNetwork.hre, { delegate: ZERO });
    assert.equal(delegateOf(revoke.result), ZERO);
  });

  it("checks a pinned delegate's code on --network: a match signs, other or no code fails", async () => {
    const { hre, signatures } = await runtime("local");
    const { result } = await signAuth(hre, { delegate: PINNED });
    assert.equal(delegateOf(result), PINNED);
    await assertRefused(
      signAuth(hre, { delegate: PINNED_OTHER }),
      new RegExp(
        `^kms sign-auth: the code of delegate ${PINNED_OTHER} on chain 31337 has hash ${hashOf(CODE)}, which no codeHash in the allowedDelegates of key deployer matches. Nothing was signed$`,
      ),
    );
    await assertRefused(
      signAuth(hre, { delegate: PINNED_EMPTY }),
      `kms sign-auth: delegate ${PINNED_EMPTY} has no code on chain 31337, and the allowedDelegates of key deployer pin its code hash. Nothing was signed`,
    );
    assert.equal(signatures(), 1);
  });

  it("fails closed for a pinned delegate with --chain, which has no network to read code from", async () => {
    const { hre, created } = await runtime();
    for (const chain of ["31337", "0"]) {
      await assertRefused(
        signAuth(hre, { delegate: PINNED, chain, nonce: "0", force: true }),
        `kms sign-auth: key deployer pins the code hash of delegate ${PINNED}, and with --chain there is no network to read its code from. Pass --network instead. Nothing was signed`,
      );
    }
    assert.equal(created.length, 0);
  });
});

/** A connection to `local` and the deployer's library account on it. */
async function libraryAccount(options: { allowChainZeroAuthorization?: boolean } = {}) {
  const made = await runtime();
  const connection = await made.hre.network.create("local");
  const deployer = await connection.kms.getAccount(ACCOUNT_0.address, options);
  return { ...made, connection, deployer };
}

describe("allowedDelegates: library signAuthorization", () => {
  it("refuses an unlisted delegate and chain 0 for a chain-listed one, before the KMS call", async () => {
    const { connection, deployer, signatures } = await libraryAccount({
      allowChainZeroAuthorization: true,
    });
    try {
      await assertRefused(
        deployer.signAuthorization({ address: UNLISTED, chainId: CHAIN_ID, nonce: 0 }),
        `signAuthorization: key deployer may not delegate to ${UNLISTED} on chain 31337`,
      );
      await assertRefused(
        deployer.signAuthorization({ address: MAV2, chainId: 0, nonce: 0 }),
        `may not delegate to ${MAV2} on chain 0, which is every chain`,
      );
      assert.equal(signatures(), 0);
    } finally {
      await connection.close();
    }
  });

  it("signs a listed delegate, the zero address, and a pinned delegate whose code matches", async () => {
    const { connection, deployer, signatures } = await libraryAccount({
      allowChainZeroAuthorization: true,
    });
    const warn = mock.method(console, "warn", () => undefined);
    try {
      for (const [address, chainId] of [
        [MAV2, CHAIN_ID],
        [SIMPLE, 0],
        [ZERO, CHAIN_ID],
        [PINNED, CHAIN_ID],
        [PINNED, 0],
      ] as const) {
        const signed = await deployer.signAuthorization({ address, chainId, nonce: 0 });
        assert.equal(signed.address, address);
      }
      assert.equal(signatures(), 5);
      assert.deepEqual(
        warn.mock.calls.map((call): unknown => call.arguments[0]),
        [
          `hardhat-kms: the authorization is for chain 0, valid on every chain: the code hash of ${PINNED} was checked on chain 31337 only`,
        ],
      );
      await assertRefused(
        deployer.signAuthorization({ address: PINNED_OTHER, chainId: CHAIN_ID, nonce: 0 }),
        "which no codeHash in the allowedDelegates of key deployer matches",
      );
      await assertRefused(
        deployer.signAuthorization({ address: PINNED_EMPTY, chainId: CHAIN_ID, nonce: 0 }),
        "has no code on chain 31337",
      );
      assert.equal(signatures(), 5);
    } finally {
      warn.mock.restore();
      await connection.close();
    }
  });
});

/** An authorization in the form eth_sendTransaction's authorizationList takes. */
async function rpcAuthorization(
  signer: PrivateKeyAccount,
  address: string,
  nonce: number,
  chainId = CHAIN_ID,
) {
  const signed = await signer.signAuthorization({
    address: `0x${address.slice(2)}`,
    chainId,
    nonce,
  });
  return {
    chainId: `0x${chainId.toString(16)}`,
    address,
    nonce: `0x${nonce.toString(16)}`,
    yParity: `0x${signed.yParity ?? 0}`,
    r: signed.r,
    s: signed.s,
  };
}

describe("allowedDelegates: a send's self-authorizations", () => {
  it("refuses a self-authorization to an unlisted delegate in eth_sendTransaction and eth_signTransaction", async () => {
    const { hre, signatures } = await runtime();
    const connection = await hre.network.create("local");
    try {
      const self = await rpcAuthorization(ACCOUNT_0, UNLISTED, 1);
      for (const method of ["eth_sendTransaction", "eth_signTransaction"]) {
        await assertRefused(
          connection.provider.request({
            method,
            params: [{ from: ACCOUNT_0.address, to: COW.address, authorizationList: [self] }],
          }),
          `${method}: authorizationList[0] is signed by the sender and delegates it to ${UNLISTED} on chain 31337, which the allowedDelegates of key deployer do not allow; nothing was signed`,
        );
      }
      const chainZero = await rpcAuthorization(ACCOUNT_0, MAV2, 1, 0);
      await assertRefused(
        connection.provider.request({
          method: "eth_sendTransaction",
          params: [{ from: ACCOUNT_0.address, to: COW.address, authorizationList: [chainZero] }],
        }),
        `delegates it to ${MAV2} on chain 0`,
      );
      assert.equal(signatures(), 0);
    } finally {
      await connection.close();
    }
  });

  it("sends a tuple from another authority with the same delegate, and self ones that pass", async () => {
    const { hre } = await runtime();
    const connection = await hre.network.create("local");
    try {
      // The sponsor's tuple, sent by the deployer: not the deployer's delegation, not checked.
      const other = await rpcAuthorization(COW, UNLISTED, 0);
      await connection.provider.request({
        method: "eth_sendTransaction",
        params: [{ from: ACCOUNT_0.address, to: COW.address, authorizationList: [other] }],
      });
      // Nonce 1 is the deployer's next transaction, so its self-authorization takes nonce 2.
      for (const delegate of [MAV2, PINNED, ZERO]) {
        const nonce: unknown = await connection.provider.request({
          method: "eth_getTransactionCount",
          params: [ACCOUNT_0.address, "pending"],
        });
        const self = await rpcAuthorization(ACCOUNT_0, delegate, Number(nonce) + 1);
        await connection.provider.request({
          method: "eth_sendTransaction",
          params: [{ from: ACCOUNT_0.address, to: COW.address, authorizationList: [self] }],
        });
      }
      const code: unknown = await connection.provider.request({
        method: "eth_getCode",
        params: [ACCOUNT_0.address, "latest"],
      });
      // The last one cleared the delegation.
      assert.equal(code, "0x");
    } finally {
      await connection.close();
    }
  });

  it("refuses an unlisted self-authorization for a provider that keeps what it signs", async () => {
    const { hre, signatures } = await runtime(undefined, { keeps: true });
    const connection = await hre.network.create("local");
    try {
      const self = await rpcAuthorization(ACCOUNT_0, UNLISTED, 1);
      await assertRefused(
        connection.provider.request({
          method: "eth_signTransaction",
          params: [{ from: ACCOUNT_0.address, to: COW.address, authorizationList: [self] }],
        }),
        `eth_signTransaction: authorizationList[0] is signed by the sender and delegates it to ${UNLISTED} on chain 31337`,
      );
      assert.equal(signatures(), 0);
      const listed = await rpcAuthorization(ACCOUNT_0, MAV2, 1);
      const raw: unknown = await connection.provider.request({
        method: "eth_signTransaction",
        params: [{ from: ACCOUNT_0.address, to: COW.address, authorizationList: [listed] }],
      });
      assert.match(String(raw), /^0x04/);
      assert.equal(signatures(), 1);
    } finally {
      await connection.close();
    }
  });

  it("refuses the same tuple in kms sign-tx, before any signature", async () => {
    const { hre, signatures } = await runtime("local");
    const self = await rpcAuthorization(ACCOUNT_0, PINNED_OTHER, 1);
    const file = path.join(scratch, "tx.json");
    writeFileSync(file, JSON.stringify({ to: COW.address, authorizationList: [self] }));
    const writeError = mock.method(process.stderr, "write", () => true);
    try {
      await assertRefused(
        hre.tasks.getTask(["kms", "sign-tx"]).run({ key: "deployer", tx: file }),
        `kms sign-tx: the code of delegate ${PINNED_OTHER} on chain 31337 has hash ${hashOf(CODE)}`,
      );
    } finally {
      writeError.mock.restore();
    }
    assert.equal(signatures(), 0);
  });

  it("leaves a key without allowedDelegates as it was", async () => {
    const { hre } = await runtime();
    const connection = await hre.network.create("local");
    try {
      const self = await rpcAuthorization(COW, UNLISTED, 1);
      await connection.provider.request({
        method: "eth_sendTransaction",
        params: [{ from: COW.address, to: ACCOUNT_0.address, authorizationList: [self] }],
      });
    } finally {
      await connection.close();
    }
  });
});

/**
 * Runs `use` with `AWS_KMS_KEY_ID` set to `keyId` and the other variables in `env` set, then
 * restores them.
 */
async function withAwsKeyId<T>(
  keyId: string,
  use: () => Promise<T>,
  env: Record<string, string> = {},
): Promise<T> {
  const set = { ...env, AWS_KMS_KEY_ID: keyId };
  const saved = Object.fromEntries(Object.keys(set).map((name) => [name, process.env[name]]));
  Object.assign(process.env, set);
  try {
    return await use();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }
  }
}

/** The refusal of a `--kms` key that is the config key `other`. */
const refusal = (other: string) =>
  `the --kms key AWS_KMS_KEY_ID is the same KMS key as ${other}, which has allowedDelegates. Name ${other} instead, so its list applies. Nothing was signed`;

describe("allowedDelegates: a --kms key that is a listed config key", () => {
  it("kms sign-auth refuses it by key id before any KMS call, and by address pin before signing", async () => {
    await withAwsKeyId("alias/listed", async () => {
      const { hre, created } = await runtime(undefined, { kms: "aws" });
      await assertRefused(
        signAuth(hre, { key: "AWS_KMS_KEY_ID", delegate: UNLISTED, chain: "1", nonce: "0" }),
        `kms sign-auth: ${refusal("listed")}`,
      );
      assert.equal(created.length, 0);
    });
    await withAwsKeyId("alias/other", async () => {
      const { hre, signatures } = await runtime(undefined, { kms: "aws" });
      await assertRefused(
        signAuth(hre, { key: "AWS_KMS_KEY_ID", delegate: UNLISTED, chain: "1", nonce: "0" }),
        `kms sign-auth: ${refusal("pinned")}`,
      );
      assert.equal(signatures(), 0);
      // A revocation passes every list, so it signs.
      const { result } = await signAuth(hre, {
        key: "AWS_KMS_KEY_ID",
        delegate: ZERO,
        chain: "1",
        nonce: "0",
      });
      assert.equal(delegateOf(result), ZERO);
    });
  });

  it("kms sign-tx refuses it for a transaction with an authorization list", async () => {
    const self = await rpcAuthorization(ACCOUNT_0, UNLISTED, 1);
    const file = path.join(scratch, "kms-tx.json");
    writeFileSync(file, JSON.stringify({ to: COW.address, authorizationList: [self] }));
    const writeError = mock.method(process.stderr, "write", () => true);
    try {
      await withAwsKeyId("alias/listed", async () => {
        const { hre, created } = await runtime("local", { kms: "aws" });
        await assertRefused(
          hre.tasks.getTask(["kms", "sign-tx"]).run({ key: "AWS_KMS_KEY_ID", tx: file }),
          `kms sign-tx: ${refusal("listed")}`,
        );
        assert.equal(created.length, 0);
      });
      await withAwsKeyId("alias/other", async () => {
        const { hre, signatures } = await runtime("local", { kms: "aws" });
        await assertRefused(
          hre.tasks.getTask(["kms", "sign-tx"]).run({ key: "AWS_KMS_KEY_ID", tx: file }),
          `kms sign-tx: ${refusal("pinned")}`,
        );
        assert.equal(signatures(), 0);
      });
    } finally {
      writeError.mock.restore();
    }
  });
});

/**
 * The same KMS key, written differently on the config key and on the `--kms` key (#589): the
 * config key sets a region, profile or endpoint, or an ARN, and the `--kms` key reads its region
 * from `AWS_REGION`.
 */
const SAME_KEY_WRITTEN_DIFFERENTLY: readonly [string, Partial<AwsKmsKeyUserConfig>, string][] = [
  ["a region", { region: "eu-west-1" }, "alias/listed"],
  ["another region", { region: "us-east-1" }, "alias/listed"],
  ["a profile", { profile: "ops" }, "alias/listed"],
  ["an endpoint", { endpoint: "http://127.0.0.1:9" }, "alias/listed"],
  ["an alias ARN", { keyId: "arn:aws:kms:us-east-1:111122223333:alias/listed" }, "alias/listed"],
  [
    "a key id, for a key ARN",
    { keyId: "1234abcd-12ab-34cd-56ef-1234567890ab", region: "us-east-1" },
    "arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab",
  ],
];

describe("allowedDelegates: a --kms key written differently from a listed config key (#589)", () => {
  for (const [written, listedKey, kmsKeyId] of SAME_KEY_WRITTEN_DIFFERENTLY) {
    it(`kms sign-auth refuses it when the config key sets ${written}, before any KMS call`, async () => {
      await withAwsKeyId(
        kmsKeyId,
        async () => {
          const { hre, created } = await runtime(undefined, {
            kms: "aws",
            listedKey,
            awsRegion: false,
          });
          await assertRefused(
            signAuth(hre, { key: "AWS_KMS_KEY_ID", delegate: UNLISTED, chain: "1", nonce: "0" }),
            `kms sign-auth: ${refusal("listed")}`,
          );
          assert.equal(created.length, 0);
        },
        { AWS_REGION: "eu-west-1" },
      );
    });
  }

  it("kms sign-tx refuses it for a transaction with an authorization list, before any KMS call", async () => {
    const self = await rpcAuthorization(ACCOUNT_0, UNLISTED, 1);
    const file = path.join(scratch, "kms-tx-589.json");
    writeFileSync(file, JSON.stringify({ to: COW.address, authorizationList: [self] }));
    const writeError = mock.method(process.stderr, "write", () => true);
    try {
      for (const [, listedKey, kmsKeyId] of SAME_KEY_WRITTEN_DIFFERENTLY) {
        await withAwsKeyId(
          kmsKeyId,
          async () => {
            const { hre, created } = await runtime("local", {
              kms: "aws",
              listedKey,
              awsRegion: false,
            });
            await assertRefused(
              hre.tasks.getTask(["kms", "sign-tx"]).run({ key: "AWS_KMS_KEY_ID", tx: file }),
              `kms sign-tx: ${refusal("listed")}`,
            );
            assert.equal(created.length, 0);
          },
          { AWS_REGION: "eu-west-1" },
        );
      }
    } finally {
      writeError.mock.restore();
    }
  });
});

describe("allowedDelegates: a --kms Azure key written differently from a listed config key (#589)", () => {
  it("kms sign-auth refuses a versioned --kms key for an unversioned listed key, before any KMS call", async () => {
    const saved = process.env.AZURE_KEY_VAULT_KEY_ID;
    // The same key, with a version, another case and a trailing slash.
    process.env.AZURE_KEY_VAULT_KEY_ID = "https://V.vault.azure.net/keys/Listed/0123abcd/";
    try {
      const hre = await createHardhatRuntimeEnvironment(
        {
          plugins: [hardhatKms],
          kms: {
            keys: {
              listed: {
                provider: "azure",
                keyId: "https://v.vault.azure.net/keys/listed",
                allowedDelegates: ALLOWED,
              },
            },
          },
        },
        { kms: "azure" },
      );
      let adapters = 0;
      hre.hooks.registerHandlers("kms", {
        createKeyAdapter: async (context, key, next) => {
          adapters += 1;
          return await next(context, key);
        },
      });
      await assertRefused(
        signAuth(hre, {
          key: "AZURE_KEY_VAULT_KEY_ID",
          delegate: UNLISTED,
          chain: "1",
          nonce: "0",
        }),
        "kms sign-auth: the --kms key AZURE_KEY_VAULT_KEY_ID is the same KMS key as listed, which has allowedDelegates. Name listed instead, so its list applies. Nothing was signed",
      );
      assert.equal(adapters, 0);
    } finally {
      if (saved === undefined) {
        Reflect.deleteProperty(process.env, "AZURE_KEY_VAULT_KEY_ID");
      } else {
        process.env.AZURE_KEY_VAULT_KEY_ID = saved;
      }
    }
  });
});
