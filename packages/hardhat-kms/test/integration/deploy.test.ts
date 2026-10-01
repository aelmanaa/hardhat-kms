// Deploying and calling a contract from KMS accounts through hardhat-viem, hardhat-ethers and
// Hardhat Ignition, on edr-simulated networks. EDR holds none of the KMS keys, so every
// transaction from a KMS account must be signed by the plugin.
import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, before, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";

import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatIgnitionViem from "@nomicfoundation/hardhat-ignition-viem";
import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import type { PublicClient } from "@nomicfoundation/hardhat-viem/types";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import { type Address, getAddress } from "viem";

import hardhatKms from "../../src/index.ts";
import type { KmsKeyUserConfig } from "../../src/types.ts";
import CounterModule from "../fixture-projects/deploy/ignition/modules/Counter.ts";
import {
  addressOfSecretKey,
  type FakeAdapter,
  type FakeAdapterOptions,
  fakeAdapter,
} from "../helpers/fake-adapter.ts";
import { COW_ACCOUNT, HARDHAT_ACCOUNT_0 } from "../helpers/vectors.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixture-projects/deploy");
const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const ONE_ETHER = 10n ** 18n;
/** EDR's default accounts on an edr-simulated network without `accounts`. */
const LOCAL_ACCOUNTS = 20;
const LOCAL_ACCOUNT_0: Address = getAddress(HARDHAT_ACCOUNT_0.address);

/**
 * The fake KMS behind each key name. Neither key is one of EDR's default accounts, so EDR cannot
 * sign for them. `cow` returns only high-S DER signatures, as AWS KMS often does; `other` returns
 * low-S r‖s signatures, as Azure does.
 */
const KEYS: Record<string, FakeAdapterOptions> = {
  cow: { secretKey: hex(COW_ACCOUNT.secretKey), highS: true, format: "der" },
  other: { secretKey: hex("42".repeat(32)), format: "compact" },
  AWS_KMS_KEY_ID: { secretKey: hex("43".repeat(32)), highS: true, format: "der" },
};
const accountOf = (name: string): Address =>
  getAddress(addressOfSecretKey(KEYS[name]?.secretKey ?? new Uint8Array()));
const COW: Address = accountOf("cow");
const OTHER: Address = accountOf("other");

/** The ABI of `contracts/Counter.sol`. */
const COUNTER_ABI = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "label",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "count",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "add",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;

/** A key of a fake third-party provider, which the tests serve through the `kms` hook. */
function vaultKey(name: string): KmsKeyUserConfig {
  const key: unknown = { provider: "myvault", name };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a third-party provider's key
  return key as KmsKeyUserConfig;
}

/** Serves the fake adapters through the `kms` hook, and records each one by key name. */
function serveAdapters(hre: HardhatRuntimeEnvironment): Record<string, FakeAdapter> {
  const created: Record<string, FakeAdapter> = {};
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async (context, key, next) => {
      const options = KEYS[key.name];
      if (options === undefined) {
        return await next(context, key);
      }
      const adapter = fakeAdapter(options);
      created[key.name] = adapter;
      return await Promise.resolve(adapter);
    },
  });
  return created;
}

/** The number of KMS signatures made so far by each key that signed. */
function signatures(created: Record<string, FakeAdapter>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(created)
      .map(([name, adapter]) => [name, adapter.calls.signDigest] as const)
      .filter(([, count]) => count > 0),
  );
}

/**
 * A runtime with viem, ethers, Ignition and two KMS keys funded by `kms.simulatedBalance`.
 * `kmsOnly` has no local accounts, so its first KMS account is account 0; `mixed` keeps EDR's 20
 * default accounts and lists the KMS accounts after them.
 */
async function runtime(globalOptions: { network?: string } = {}) {
  const hre = await createHardhatRuntimeEnvironment(
    {
      plugins: [hardhatKms, hardhatViem, hardhatEthers, hardhatIgnitionViem],
      solidity: "0.8.24",
      kms: {
        keys: { cow: vaultKey("cow"), other: vaultKey("other") },
        simulatedBalance: ONE_ETHER,
      },
      networks: {
        kmsOnly: { type: "edr-simulated", accounts: [], kmsAccounts: ["cow", "other"] },
        mixed: { type: "edr-simulated", kmsAccounts: ["cow", "other"] },
      },
    },
    globalOptions,
    root,
  );
  return { hre, created: serveAdapters(hre) };
}

/**
 * The address of a contract Ignition deployed. hardhat-ignition-viem types its results from the
 * project's generated artifact types, which the tests do not load, so the result is checked here.
 */
function deployed(contract: unknown): Address {
  assert.ok(
    typeof contract === "object" &&
      contract !== null &&
      "address" in contract &&
      typeof contract.address === "string",
  );
  return getAddress(contract.address);
}

/** Reads a counter's state. */
async function counterState(
  publicClient: PublicClient,
  address: Address,
): Promise<{ owner: Address; label: string; count: bigint }> {
  const read = { address, abi: COUNTER_ABI } as const;
  return {
    owner: await publicClient.readContract({ ...read, functionName: "owner" }),
    label: await publicClient.readContract({ ...read, functionName: "label" }),
    count: await publicClient.readContract({ ...read, functionName: "count" }),
  };
}

describe("deploying from KMS accounts", { timeout: 300_000 }, () => {
  before(async () => {
    const { hre } = await runtime();
    await hre.tasks.getTask("build").run({ quiet: true });
  });

  describe("hardhat-viem", () => {
    it("deploys with constructor arguments, writes and reads back from a KMS account", async () => {
      const { hre, created } = await runtime();
      const { viem } = await hre.network.create("kmsOnly");
      const publicClient = await viem.getPublicClient();
      const wallet = await viem.getWalletClient(COW);

      const { contract, deploymentTransaction } = await viem.sendDeploymentTransaction(
        "Counter",
        ["viem", 7n],
        { client: { wallet } },
      );
      const deployReceipt = await publicClient.waitForTransactionReceipt({
        hash: deploymentTransaction.hash,
      });
      assert.equal(deployReceipt.status, "success");
      assert.equal(getAddress(deployReceipt.from), COW);
      assert.equal(getAddress(deploymentTransaction.from), COW);

      const hash = await wallet.writeContract({
        address: contract.address,
        abi: COUNTER_ABI,
        functionName: "add",
        args: [5n],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      assert.equal(getAddress(receipt.from), COW);

      assert.deepEqual(await counterState(publicClient, contract.address), {
        owner: COW,
        label: "viem",
        count: 12n,
      });
      assert.equal(await publicClient.getTransactionCount({ address: COW }), 2);
      // One high-S KMS signature per transaction: none was rejected and asked for again.
      assert.deepEqual(signatures(created), { cow: 2 });
    });

    it("deploys with viem.deployContract and waits for it, from a low-S KMS account", async () => {
      const { hre, created } = await runtime();
      const { viem } = await hre.network.create("kmsOnly");
      const publicClient = await viem.getPublicClient();
      const wallet = await viem.getWalletClient(OTHER);

      const counter = await viem.deployContract("Counter", ["other", 1n], {
        client: { wallet },
      });

      assert.deepEqual(await counterState(publicClient, counter.address), {
        owner: OTHER,
        label: "other",
        count: 1n,
      });
      assert.deepEqual(signatures(created), { other: 1 });
    });
  });

  describe("hardhat-ethers", () => {
    it("deploys with constructor arguments, writes and reads back through getSigner", async () => {
      const { hre, created } = await runtime();
      const { ethers } = await hre.network.create("kmsOnly");
      const signer = await ethers.getSigner(COW);

      const counter = await ethers.deployContract("Counter", ["ethers", 7n], signer);
      await counter.waitForDeployment();
      const deployReceipt = await counter.deploymentTransaction()?.wait();
      assert.ok(deployReceipt);
      assert.equal(deployReceipt.status, 1);
      assert.equal(deployReceipt.from, COW);

      const tx = await counter.getFunction("add").send(5n);
      const receipt = await tx.wait();
      assert.ok(receipt);
      assert.equal(receipt.status, 1);
      assert.equal(receipt.from, COW);

      assert.equal(await counter.getFunction("owner")(), COW);
      assert.equal(await counter.getFunction("label")(), "ethers");
      assert.equal(await counter.getFunction("count")(), 12n);
      assert.equal(await ethers.provider.getTransactionCount(COW), 2);
      assert.deepEqual(signatures(created), { cow: 2 });
    });
  });

  describe("Hardhat Ignition", () => {
    it("deploys a module with a KMS account as defaultSender", async () => {
      const { hre, created } = await runtime();
      const { ignition, viem } = await hre.network.create("mixed");
      const publicClient = await viem.getPublicClient();

      const { counter } = await ignition.deploy(CounterModule, {
        defaultSender: COW,
        parameters: { Counter: { label: "from cow" } },
      });

      // The constructor recorded the deployer, and `add` only succeeds from it.
      assert.deepEqual(await counterState(publicClient, deployed(counter)), {
        owner: COW,
        label: "from cow",
        count: 12n,
      });
      assert.equal(await publicClient.getTransactionCount({ address: COW }), 2);
      assert.equal(await publicClient.getTransactionCount({ address: LOCAL_ACCOUNT_0 }), 0);
      assert.deepEqual(signatures(created), { cow: 2 });
    });

    it("deploys from the KMS account chosen by index with m.getAccount", async () => {
      const { hre, created } = await runtime();
      const { ignition, viem } = await hre.network.create("mixed");
      const publicClient = await viem.getPublicClient();
      // EDR's 20 accounts come first, then `cow`, then `other`.
      const ByIndex = buildModule("ByIndex", (m) => {
        const local = m.contract("Counter", ["local", 1n], { id: "Local" });
        const kms = m.contract("Counter", ["kms", 2n], {
          id: "Kms",
          from: m.getAccount(LOCAL_ACCOUNTS + 1),
        });
        m.call(kms, "add", [3n], { from: m.getAccount(LOCAL_ACCOUNTS + 1) });
        return { local, kms };
      });

      const { local, kms } = await ignition.deploy(ByIndex);

      assert.equal((await counterState(publicClient, deployed(local))).owner, LOCAL_ACCOUNT_0);
      assert.deepEqual(await counterState(publicClient, deployed(kms)), {
        owner: OTHER,
        label: "kms",
        count: 5n,
      });
      assert.deepEqual(signatures(created), { other: 2 });
    });

    it("uses the first KMS account by default on a network without local accounts", async () => {
      const { hre, created } = await runtime();
      const { ignition, viem } = await hre.network.create("kmsOnly");
      const publicClient = await viem.getPublicClient();

      const { counter } = await ignition.deploy(CounterModule);

      assert.deepEqual(await counterState(publicClient, deployed(counter)), {
        owner: COW,
        label: "ignition",
        count: 12n,
      });
      assert.deepEqual(signatures(created), { cow: 2 });
    });

    it("runs the ignition deploy task with a KMS account as default sender", async () => {
      const { hre, created } = await runtime({ network: "mixed" });
      // Ignition's progress display prints its banner ("running Hardhat Ignition against an
      // in-process instance") and the module name with process.stdout.write, and the rest with
      // console.log. Silence both while the task runs.
      const log = mock.method(console, "log", () => {});
      const write = mock.method(process.stdout, "write", () => true);
      let result: unknown;
      try {
        result = await hre.tasks.getTask(["ignition", "deploy"]).run({
          modulePath: path.join(root, "ignition/modules/Counter.ts"),
          defaultSender: COW,
        });
      } finally {
        write.mock.restore();
        log.mock.restore();
      }

      assert.ok(typeof result === "object" && result !== null && "type" in result);
      assert.equal(result.type, "SUCCESSFUL_DEPLOYMENT");
      // The task's simulated chain is gone when it returns, so the contract cannot be read back.
      // The KMS signature count is the guard instead: had Ignition fallen back to a local sender,
      // EDR would have signed and the count would be 0.
      assert.deepEqual(signatures(created), { cow: 2 });
    });
  });

  describe("local and KMS accounts on one network", () => {
    it("lists local accounts first and deploys from each in one script", async () => {
      const { hre, created } = await runtime();
      const { viem, ethers, provider } = await hre.network.create("mixed");
      const publicClient = await viem.getPublicClient();

      const accounts = await provider.request({ method: "eth_accounts" });
      assert.ok(Array.isArray(accounts));
      assert.equal(accounts.length, LOCAL_ACCOUNTS + 2);
      assert.equal(getAddress(String(accounts[0])), LOCAL_ACCOUNT_0);
      assert.deepEqual(
        accounts.slice(LOCAL_ACCOUNTS).map((account) => getAddress(String(account))),
        [COW, OTHER],
      );
      const signers = await ethers.getSigners();
      assert.equal(signers[0]?.address, LOCAL_ACCOUNT_0);
      assert.equal(signers[LOCAL_ACCOUNTS]?.address, COW);

      // Without a wallet client, hardhat-viem deploys from account 0, a local account.
      const local = await viem.deployContract("Counter", ["local", 1n]);
      const kmsWallet = await viem.getWalletClient(COW);
      const kms = await viem.deployContract("Counter", ["kms", 2n], {
        client: { wallet: kmsWallet },
      });
      const localWallet = await viem.getWalletClient(LOCAL_ACCOUNT_0);
      await publicClient.waitForTransactionReceipt({
        hash: await localWallet.writeContract({
          address: local.address,
          abi: COUNTER_ABI,
          functionName: "add",
          args: [10n],
        }),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await kmsWallet.writeContract({
          address: kms.address,
          abi: COUNTER_ABI,
          functionName: "add",
          args: [20n],
        }),
      });

      assert.deepEqual(await counterState(publicClient, local.address), {
        owner: LOCAL_ACCOUNT_0,
        label: "local",
        count: 11n,
      });
      assert.deepEqual(await counterState(publicClient, kms.address), {
        owner: COW,
        label: "kms",
        count: 22n,
      });
      // The local account cannot change the KMS account's counter.
      await assert.rejects(
        localWallet.writeContract({
          address: kms.address,
          abi: COUNTER_ABI,
          functionName: "add",
          args: [1n],
        }),
        /not the owner/,
      );
      // Only the KMS account's two transactions went to KMS.
      assert.deepEqual(signatures(created), { cow: 2 });
    });
  });

  describe("--kms", () => {
    const saved = process.env.AWS_KMS_KEY_ID;
    afterEach(() => {
      if (saved === undefined) {
        Reflect.deleteProperty(process.env, "AWS_KMS_KEY_ID");
      } else {
        process.env.AWS_KMS_KEY_ID = saved;
      }
    });

    it("deploys through viem from a key chosen on the command line, funded by simulatedBalance", async () => {
      process.env.AWS_KMS_KEY_ID = "alias/deployer";
      const hre = await createHardhatRuntimeEnvironment(
        {
          plugins: [hardhatKms, hardhatViem],
          solidity: "0.8.24",
          kms: { simulatedBalance: ONE_ETHER },
          networks: { local: { type: "edr-simulated" } },
        },
        { kms: "aws", network: "local" },
        root,
      );
      const created = serveAdapters(hre);
      const deployer = accountOf("AWS_KMS_KEY_ID");
      const { viem } = await hre.network.create("local");
      const publicClient = await viem.getPublicClient();
      assert.equal(await publicClient.getBalance({ address: deployer }), ONE_ETHER);

      const wallet = await viem.getWalletClient(deployer);
      const counter = await viem.deployContract("Counter", ["cli", 3n], { client: { wallet } });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: await wallet.writeContract({
          address: counter.address,
          abi: COUNTER_ABI,
          functionName: "add",
          args: [4n],
        }),
      });

      assert.equal(getAddress(receipt.from), deployer);
      assert.deepEqual(await counterState(publicClient, counter.address), {
        owner: deployer,
        label: "cli",
        count: 7n,
      });
      assert.deepEqual(signatures(created), { AWS_KMS_KEY_ID: 2 });
    });
  });
});
