// The live tests: `pnpm run test:live`. For each provider whose key variable is set, it runs the
// cases of the transaction matrix (`matrix.ts`, steps in `cases.ts`) from the KMS account through
// the plugin: transfers, deploys, calls with value, reverts, replacements and EIP-7702 delegations
// across the transaction types, and a `personal_sign` and an `eth_signTypedData_v4` signature
// checked on chain with `ecrecover`. A run ends by clearing every delegation it made or found, also
// after a failure, and then checks that every cell it runs has a receipt with the expected status,
// sender and type. Providers without a key are skipped and reported; the configured ones run in
// parallel.
//
// By default the suite runs on a local anvil fork of Sepolia, with each account funded by
// `anvil_setBalance`: it signs with the real keys and spends nothing. It runs the live and the
// fork-only cases. Anvil reads Sepolia through a proxy that refuses and records any send, and the
// run fails if one was attempted. HARDHAT_KMS_LIVE_NETWORK=sepolia runs the live cases on Sepolia
// itself, which spends Sepolia ETH and writes `test/live/proof.json`, from which
// `pnpm run docs:live-proof` renders `docs/live-proof.md`.
//
// - HARDHAT_KMS_LIVE_AWS_KEY_ID: an ECC_SECG_P256K1 key id, alias or ARN. AWS_REGION, or the key's
//   ARN, gives the region.
// - HARDHAT_KMS_LIVE_GCP_KEY: the full name of an EC_SIGN_SECP256K1_SHA256 key version.
// - HARDHAT_KMS_LIVE_AZURE_KEY_ID: the versioned URL of a P-256K key.
// - HARDHAT_KMS_LIVE_SEPOLIA_RPC_URL: optional; a public RPC without an API key is the default.
//
// The tests use the developer's own cloud logins and create no cloud resources. Each account must
// hold the run's floor (the case table's gas at the run's gas price), and on Sepolia the legacy gas
// price must be at most MAX_GAS_PRICE, or the test fails before sending anything. Key ids, resource
// names, URLs and signed data are redacted from every failure.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import hardhatViem from "@nomicfoundation/hardhat-viem";
import type { KmsKeyConfig, KmsKeyUserConfig } from "hardhat-kms/types";
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import {
  type Address,
  formatEther,
  formatGwei,
  getAddress,
  parseEther,
  parseGwei,
  toHex,
  zeroAddress,
} from "viem";

// The EIP-7702 authorizations are signed by the core signer loaded from `src`, while the
// transactions go through the plugin built in `dist`. The plugin has no library API to sign an
// authorization yet (#51).
// The provider plugins come from their `src`, so their types resolve before any package is built,
// as in the lint job.
import hardhatKmsAws from "../../packages/hardhat-kms-aws/src/index.ts";
import hardhatKmsAzure from "../../packages/hardhat-kms-azure/src/index.ts";
import hardhatKmsGcp from "../../packages/hardhat-kms-gcp/src/index.ts";
import { KmsSigner } from "../../packages/hardhat-kms/src/internal/signer/kms-signer.ts";
import { ProviderRun, SEPOLIA_CHAIN_ID, setLiveCheckBytecode } from "./cases.ts";
import { type AnvilFork, findAnvil, startAnvilFork } from "./helpers/anvil.ts";
import { legacyGasPrice } from "./helpers/gas.ts";
import { SharedLock } from "./helpers/lock.ts";
import { liveMode, MODE_VARIABLE } from "./helpers/mode.ts";
import { type Proof, proofProblems, type ProviderProof } from "./helpers/proof.ts";
import { redact } from "./helpers/redact.ts";
import { retryLagging } from "./helpers/retry.ts";
import { type RecordingProxy, startRecordingProxy } from "./helpers/rpc-proxy.ts";
import { balanceFloor, casesFor, missingCells } from "./matrix.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture-project");

/** Where the Sepolia run writes its proof. */
const PROOF_FILE = path.join(path.dirname(root), "proof.json");

/** Where the transactions go; throws at load on a value other than `fork` or `sepolia`. */
const mode = liveMode(process.env);
const onFork = mode === "fork";

/** Used when HARDHAT_KMS_LIVE_SEPOLIA_RPC_URL is not set. Needs no API key. */
const DEFAULT_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const RPC_VARIABLE = "HARDHAT_KMS_LIVE_SEPOLIA_RPC_URL";
/** Above this gas price the test refuses to send, so a fee spike cannot drain the accounts. */
const MAX_GAS_PRICE = parseGwei("20");
/** How long to wait for each receipt: 25 Sepolia blocks, or a minute on the fork, which mines at once. */
const RECEIPT_TIMEOUT_MS = onFork ? 60_000 : 300_000;
/** On the fork, how long a transaction may stay pending before the test mines a block itself. */
const FORK_NUDGE_MS = 15_000;
/** Code of an account with no delegation, as viem returns it. */
const NO_CODE = [undefined, "0x"];
/** What `anvil_setBalance` gives each account on the fork. */
const FORK_BALANCE = parseEther("10");
/** The fork's rules: Prague is the first with EIP-7702. */
const FORK_HARDFORK = "prague";

const env = (name: string): string => process.env[name]?.trim() ?? "";
const rpcUrl = env(RPC_VARIABLE);

interface Provider {
  /** The network's name and the test's label. */
  name: "aws" | "gcp" | "azure";
  variable: string;
  key: KmsKeyUserConfig;
}

const PROVIDERS: Provider[] = [
  {
    name: "aws",
    variable: "HARDHAT_KMS_LIVE_AWS_KEY_ID",
    key: { provider: "aws", keyId: configVariable("HARDHAT_KMS_LIVE_AWS_KEY_ID") },
  },
  {
    name: "gcp",
    variable: "HARDHAT_KMS_LIVE_GCP_KEY",
    key: { provider: "gcp", keyVersionName: configVariable("HARDHAT_KMS_LIVE_GCP_KEY") },
  },
  {
    name: "azure",
    variable: "HARDHAT_KMS_LIVE_AZURE_KEY_ID",
    key: { provider: "azure", keyId: configVariable("HARDHAT_KMS_LIVE_AZURE_KEY_ID") },
  },
];
const configured = PROVIDERS.filter((provider) => env(provider.variable) !== "");

/** The KMS accounts the fork run used, for the proxy check. */
const forkAccounts = new Set<Address>();
/** How many times the fork run mined a block itself with `evm_mine`. */
let nudges = 0;
/** Held shared by every case, and alone by a replacement case, which stops automine on the fork. */
const lock = new SharedLock();
/** What each provider of a Sepolia run proved, for test/live/proof.json. */
const proofs: { proof: ProviderProof; firstBlockTime: string; lastBlockTime: string }[] = [];
/** Reads of an account's state that anvil sends upstream the first time it touches the account. */
const ACCOUNT_READS = new Set([
  "eth_getAccount",
  "eth_getAccountInfo",
  "eth_getBalance",
  "eth_getTransactionCount",
]);

/**
 * Runs `step` and fails with any error's name and message redacted. The original error is not
 * passed on, since node:test would print it.
 */
async function redacted<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    const name = error instanceof Error ? error.name : typeof error;
    const message = error instanceof Error ? error.message : String(error);
    return assert.fail(redact(`${name}: ${message}`, process.env));
  }
}

/**
 * The runtime, with one http network per configured provider.
 *
 * @param forkUrl - The anvil fork's URL, required in fork mode; Sepolia mode uses the Sepolia RPC.
 */
async function runtime(forkUrl?: string): Promise<HardhatRuntimeEnvironment> {
  // Fail closed: fork mode never falls back to the Sepolia RPC.
  if (onFork && forkUrl === undefined) {
    throw new Error("fork mode has no fork URL");
  }
  const url = forkUrl ?? (rpcUrl === "" ? DEFAULT_RPC_URL : configVariable(RPC_VARIABLE));
  return await createHardhatRuntimeEnvironment(
    {
      plugins: [hardhatKmsAws, hardhatKmsGcp, hardhatKmsAzure, hardhatViem],
      solidity: "0.8.24",
      networks: Object.fromEntries(
        configured.map((provider) => [
          provider.name,
          {
            type: "http",
            chainType: "l1",
            url,
            chainId: SEPOLIA_CHAIN_ID,
            accounts: [],
            kmsAccounts: [provider.key],
          },
        ]),
      ),
    },
    {},
    root,
  );
}

/** The resolved key of a network: the one in its `kmsAccounts`. */
function keyOf(hre: HardhatRuntimeEnvironment, name: string): KmsKeyConfig {
  const key = hre.config.networks[name]?.kmsAccounts[0];
  assert.ok(key !== undefined, `network ${name} has no KMS key`);
  return key;
}

/**
 * The core signer for a key, over an adapter from the providers' `kms` hook. The test signs the
 * EIP-7702 authorization with it, since the plugin has no RPC method for that.
 */
async function coreSigner(hre: HardhatRuntimeEnvironment, key: KmsKeyConfig): Promise<KmsSigner> {
  const adapter = await hre.hooks.runHandlerChain(
    "kms",
    "createKeyAdapter",
    [key],
    async (_context, rest: KmsKeyConfig) =>
      await Promise.reject(new Error(`no provider claimed ${rest.provider}`)),
  );
  return new KmsSigner(adapter, {
    timeoutMs: 60_000,
    displayMessage: async () => {},
    displayId: key.displayId,
  });
}

const errorText = (error: Error): string => `${error.name}: ${error.message}`;
const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/**
 * What a failed cleanup may have left, and how to undo it. A pending transaction stuck under a
 * rising base fee also blocks the clear, which takes the next nonce.
 */
function leftDelegated(run: ProviderRun, account: Address, network: string): string {
  const own = run.delegated
    ? `${account} may still delegate to this run's code. Once any pending transaction from it is ` +
      "mined or replaced, clear it: sign an authorization of the zero address with " +
      `\`npx hardhat kms sign-auth --network ${network} --self-broadcast <key> ${zeroAddress}\` and send ` +
      "it in an eth_sendTransaction from the account to itself with that authorizationList. "
    : "";
  const throwaway = run.throwawayDelegated
    ? "The run's throwaway key may still delegate to LiveCheck. Its key existed only in memory, so " +
      "that delegation stays; the account holds no ETH, and only the KMS account can call add on it."
    : "";
  return `${own}${throwaway}`.trim() || "No delegation was left set.";
}

/** Runs one provider's cases, and reports what it sent as test diagnostics. */
async function runProvider(
  hre: HardhatRuntimeEnvironment,
  provider: Provider,
  t: TestContext,
  forkUrl: string | undefined,
): Promise<void> {
  const signer = await coreSigner(hre, keyOf(hre, provider.name));
  try {
    const account = getAddress(await signer.getAddress());
    if (onFork) {
      forkAccounts.add(account);
    }
    const { viem, provider: rpc } = await hre.network.create(provider.name);
    const publicClient = await viem.getPublicClient();
    const wallet = await viem.getWalletClient(account);

    assert.equal(await publicClient.getChainId(), SEPOLIA_CHAIN_ID, "the RPC is not Sepolia");
    if (onFork) {
      // Only anvil takes anvil_setBalance, so an account is funded only on the fork, and an RPC
      // that is not anvil fails here, before anything is signed or sent.
      const client: unknown = await rpc.request({ method: "web3_clientVersion" });
      assert.ok(
        typeof client === "string" && client.startsWith("anvil/"),
        "fork mode is not talking to anvil",
      );
      await rpc.request({ method: "anvil_setBalance", params: [account, toHex(FORK_BALANCE)] });
    }
    const accounts: unknown = await rpc.request({ method: "eth_accounts" });
    assert.ok(
      Array.isArray(accounts) &&
        accounts.some((item) => typeof item === "string" && getAddress(item) === account),
      "eth_accounts does not list the KMS account",
    );
    // The legacy and EIP-2930 transactions pay this price; it must clear a rising base fee.
    const nodeGasPrice = await publicClient.getGasPrice();
    const { baseFeePerGas } = await publicClient.getBlock({ blockTag: "latest" });
    const gasPrice = legacyGasPrice(nodeGasPrice, baseFeePerGas ?? 0n);
    // The cap protects real Sepolia ETH; the fork's ETH is minted, so a Sepolia fee spike cannot
    // cost anything there.
    if (!onFork && gasPrice > MAX_GAS_PRICE) {
      assert.fail(
        `the legacy gas price would be ${formatGwei(gasPrice)} gwei (eth_gasPrice ${formatGwei(nodeGasPrice)} gwei, ` +
          `base fee ${formatGwei(baseFeePerGas ?? 0n)} gwei), above the cap of ${formatGwei(MAX_GAS_PRICE)} gwei. ` +
          "Run again when Sepolia is cheaper.",
      );
    }
    // The floor comes from the case table: every case's gas budget at this price, which is at
    // least twice the base fee, so it also covers the EIP-1559 and EIP-7702 transactions.
    const floor = balanceFloor(mode, gasPrice);
    const balance = await publicClient.getBalance({ address: account });
    if (balance < floor) {
      assert.fail(
        `${account} holds ${formatEther(balance)} ETH, below this run's floor of ${formatEther(floor)} ETH ` +
          `at ${formatGwei(gasPrice)} gwei. Fund it with Sepolia ETH and run again.`,
      );
    }
    t.diagnostic(
      `${provider.name}: ${account} holds ${formatEther(balance)} ETH${onFork ? " on the fork" : ""}, ` +
        `floor ${formatEther(floor)} ETH, legacy gas price ${formatGwei(gasPrice)} gwei`,
    );

    const run = new ProviderRun({
      provider: provider.name,
      t,
      account,
      signer,
      rpc,
      publicClient,
      wallet,
      gasPrice,
      forkUrl,
      receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
      forkNudgeMs: FORK_NUDGE_MS,
      onNudge: () => {
        nudges++;
      },
    });
    // An account left delegated by an earlier run is cleared at the end too.
    run.delegated = !NO_CODE.includes(await publicClient.getCode({ address: account }));

    let failure: Error | undefined;
    try {
      for (const item of casesFor(mode)) {
        if (item.cleanup === true) {
          continue;
        }
        // The cleanup case runs after the loop, also after a failure. A replacement turns
        // automine off on the shared fork, so it runs while no other provider's case does.
        const alone = item.covers.some((cell) => cell.startsWith("replacement/"));
        await (alone
          ? lock.exclusive(async () => await run.run(item.id))
          : lock.shared(async () => await run.run(item.id)));
      }
    } catch (error) {
      failure = asError(error);
    }

    // Always clear a delegation, even after a failure: no account may stay delegated.
    try {
      await lock.shared(async () => {
        await run.cleanUp();
      });
    } catch (error) {
      const cleared = new Error(
        `clearing the delegations failed: ${errorText(asError(error))}. ${leftDelegated(run, account, provider.name)}`,
      );
      failure =
        failure === undefined ? cleared : new Error(`${errorText(failure)}; ${errorText(cleared)}`);
    }
    if (failure !== undefined) {
      throw failure;
    }

    // The per-run check: every cell this mode runs has a receipt with its case's status, sender
    // and type.
    assert.deepEqual(missingCells(mode, run.records), [], "cells without a receipt");
    assert.ok(
      run.revertNoncesChecked > 0,
      "no plugin-filled transaction followed a revert, so the nonce after a revert went unchecked",
    );
    const sent = run.records.filter((record) => record.hash !== null).length;
    // The gas the live cases used, which is what a Sepolia run pays for.
    const liveGas = run.records
      .filter(
        (record) =>
          record.from === "kms" && casesFor("sepolia").some((item) => item.id === record.case),
      )
      .reduce((sum, record) => sum + BigInt(record.gasUsed ?? "0"), 0n);

    // A fork run's hashes exist on no public chain, so it writes no proof for docs/live-proof.md.
    if (onFork) {
      t.diagnostic(
        `${provider.name}: fork run passed: ${casesFor(mode).length} cases, ${sent} transactions, ` +
          `${liveGas} gas in the live cases; not a live proof`,
      );
      return;
    }
    const contract = run.contract;
    const first = run.firstBlock;
    const last = run.lastBlock;
    assert.ok(
      contract !== undefined && first !== undefined && last !== undefined,
      "the run sent nothing",
    );
    const spent = run.records
      .filter((record) => record.from === "kms" && record.hash !== null)
      .reduce(
        (sum, record) =>
          sum + BigInt(record.gasUsed ?? "0") * BigInt(record.effectiveGasPrice ?? "0"),
        0n,
      );
    const timeOf = async (blockNumber: bigint): Promise<string> =>
      new Date(
        Number(
          (await retryLagging(async () => await publicClient.getBlock({ blockNumber }))).timestamp,
        ) * 1000,
      ).toISOString();
    proofs.push({
      proof: {
        provider: provider.name,
        account,
        liveCheck: contract,
        spent: formatEther(spent),
        records: run.records,
      },
      firstBlockTime: await timeOf(first),
      lastBlockTime: await timeOf(last),
    });
    t.diagnostic(
      `${provider.name}: ${sent} transactions, ${liveGas} gas, spent ${formatEther(spent)} ETH`,
    );
  } finally {
    await signer.close();
  }
}

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: path.dirname(root), encoding: "utf8" }).trim();

/** Writes test/live/proof.json from a Sepolia run in which every configured provider passed. */
function writeProof(): void {
  const order = PROVIDERS.map((provider) => provider.name);
  const sorted = proofs.toSorted(
    (a, b) => order.indexOf(a.proof.provider) - order.indexOf(b.proof.provider),
  );
  const proof: Proof = {
    chainId: SEPOLIA_CHAIN_ID,
    commit: git("rev-parse", "--short", "HEAD"),
    subject: git("log", "-1", "--format=%s"),
    firstBlockTime: sorted.map((item) => item.firstBlockTime).toSorted()[0] ?? "",
    lastBlockTime:
      sorted
        .map((item) => item.lastBlockTime)
        .toSorted()
        .at(-1) ?? "",
    providers: sorted.map((item) => item.proof),
  };
  const problems = proofProblems(proof);
  assert.deepEqual(problems, [], "the run's proof is incomplete");
  writeFileSync(PROOF_FILE, `${JSON.stringify(proof, null, 2)}\n`);
}

describe(onFork ? "live on a Sepolia fork" : "live on Sepolia", () => {
  let hre: HardhatRuntimeEnvironment;
  let proxy: RecordingProxy | undefined;
  let fork: AnvilFork | undefined;

  before(async () => {
    if (configured.length === 0) {
      return;
    }
    await redacted(async () => {
      if (onFork) {
        const binary = findAnvil(process.env);
        if (binary === undefined) {
          assert.fail(
            `fork mode needs anvil, from Foundry (https://getfoundry.sh), on PATH or in ~/.foundry/bin. ` +
              `To run on Sepolia instead, set ${MODE_VARIABLE}=sepolia.`,
          );
        }
        proxy = await startRecordingProxy(rpcUrl === "" ? DEFAULT_RPC_URL : rpcUrl);
        fork = await startAnvilFork({ binary, forkUrl: proxy.url, hardfork: FORK_HARDFORK });
      }
      hre = await runtime(fork?.url);
      await hre.tasks.getTask("build").run({ quiet: true });
      setLiveCheckBytecode((await hre.artifacts.readArtifact("LiveCheck")).bytecode);
    });
  });

  after(async () => {
    await fork?.close();
    await proxy?.close();
  });

  describe("providers", { concurrency: true, timeout: 1_800_000 }, () => {
    for (const provider of PROVIDERS) {
      const skip = configured.includes(provider) ? false : `${provider.variable} is not set`;
      it(
        `${provider.name}: runs every ${onFork ? "live and fork" : "live"} case of the matrix`,
        { skip },
        async (t) => {
          await redacted(async () => {
            await runProvider(hre, provider, t, fork?.url);
          });
        },
      );
    }
  });

  // Only a Sepolia run in which every configured provider passed writes the proof.
  // A proof covers all three providers, so a run with fewer cannot overwrite a complete one.
  const skipWrite = onFork
    ? "a fork run writes no proof"
    : configured.length < PROVIDERS.length
      ? "a proof needs all three providers configured; nothing is written"
      : false;
  it("sepolia: writes test/live/proof.json", { skip: skipWrite }, (t) => {
    assert.equal(proofs.length, configured.length, "a provider failed, so no proof was written");
    writeProof();
    t.diagnostic("wrote test/live/proof.json; render it with pnpm run docs:live-proof");
  });

  // Anvil's only way to Sepolia is its fork URL, the proxy. The proxy forwards no send and keeps
  // the name of every method it saw, so an empty refusal list means no transaction signed on the
  // fork was even offered to Sepolia.
  const skipProof = !onFork
    ? "runs only in fork mode"
    : configured.length === 0
      ? "no provider is configured"
      : false;
  it("fork: no transaction reached the Sepolia RPC", { skip: skipProof }, (t) => {
    assert.ok(proxy !== undefined, "the proxy did not start");
    const methods = proxy.methods();
    assert.deepEqual(proxy.refused(), [], "the proxy refused a request from anvil");
    // Anvil's startup calls prove nothing about the accounts. Each account's state must have been
    // read through the proxy, which shows the fork the suite sent through reads Sepolia via it.
    assert.ok(forkAccounts.size > 0, "no provider reached the fork");
    const read = new Set(
      proxy
        .forwarded()
        .flatMap((call) =>
          ACCOUNT_READS.has(call.method) && Array.isArray(call.params)
            ? [String(call.params[0]).toLowerCase()]
            : [],
        ),
    );
    for (const account of forkAccounts) {
      assert.ok(read.has(account.toLowerCase()), `anvil read ${account} without the proxy`);
    }
    t.diagnostic(
      `upstream methods: ${[...methods].map(([method, count]) => `${method} ${count}`).join(", ")}`,
    );
    t.diagnostic(`evm_mine nudges: ${nudges}`);
  });
});
