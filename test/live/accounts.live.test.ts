// The live check of `kms accounts --balances --check-sign`, run by `pnpm run test:live` next to
// the transaction matrix. For each provider whose key variable is set, it runs the task through the
// plugin on an http network whose `kmsAccounts` holds the key, and expects the key's address, its
// balance and a sign check that passed. The task signs a random EIP-191 message and sends nothing,
// so the test spends no ETH in either mode.
//
// In fork mode (the default), it starts its own anvil fork of Sepolia behind the recording proxy,
// gives each account FORK_BALANCE with `anvil_setBalance`, and expects exactly that balance. With
// HARDHAT_KMS_LIVE_NETWORK=sepolia it reads the real balance, which the matrix may be spending at
// the same time, so it expects only a decimal number of wei. The key variables are those of
// `sepolia.live.test.ts`. Key ids, URLs and signed data are redacted from every failure.
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";

import type { AccountsReport, KmsKeyUserConfig } from "hardhat-kms/types";
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import { isResult } from "hardhat/utils/result";
import { getAddress, parseEther, toHex } from "viem";

// The provider plugins come from their `src`, as in sepolia.live.test.ts; the core comes from
// `dist`, which `pnpm run test:live` builds first.
import hardhatKmsAws from "../../packages/hardhat-kms-aws/src/index.ts";
import hardhatKmsAzure from "../../packages/hardhat-kms-azure/src/index.ts";
import hardhatKmsGcp from "../../packages/hardhat-kms-gcp/src/index.ts";
import { SEPOLIA_CHAIN_ID } from "./cases.ts";
import { type AnvilFork, findAnvil, startAnvilFork } from "./helpers/anvil.ts";
import { liveMode, MODE_VARIABLE } from "./helpers/mode.ts";
import { redact } from "./helpers/redact.ts";
import { type RecordingProxy, startRecordingProxy } from "./helpers/rpc-proxy.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture-project");

const mode = liveMode(process.env);
const onFork = mode === "fork";

/** Used when HARDHAT_KMS_LIVE_SEPOLIA_RPC_URL is not set. Needs no API key. */
const DEFAULT_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const RPC_VARIABLE = "HARDHAT_KMS_LIVE_SEPOLIA_RPC_URL";
/** What `anvil_setBalance` gives each account on the fork: an odd amount, so a default cannot match. */
const FORK_BALANCE = parseEther("12.345678901234567891");
/** A 65-byte signature in hex, which nothing the task prints may hold. */
const SIGNATURE_HEX = /[0-9a-fA-F]{130}/;

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

/** Runs `step` and fails with any error's name and message redacted. */
async function redacted<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    const name = error instanceof Error ? error.name : typeof error;
    const message = error instanceof Error ? error.message : String(error);
    return assert.fail(redact(`${name}: ${message}`, process.env));
  }
}

/** A runtime with one http network for the provider, selected as `--network`. */
async function runtime(provider: Provider, url: string): Promise<HardhatRuntimeEnvironment> {
  return await createHardhatRuntimeEnvironment(
    {
      plugins: [hardhatKmsAws, hardhatKmsGcp, hardhatKmsAzure],
      networks: {
        [provider.name]: {
          type: "http",
          chainType: "l1",
          url: onFork ? url : rpcUrl === "" ? DEFAULT_RPC_URL : configVariable(RPC_VARIABLE),
          chainId: SEPOLIA_CHAIN_ID,
          accounts: [],
          kmsAccounts: [provider.key],
        },
      },
    },
    { network: provider.name },
    root,
  );
}

function isReport(value: unknown): value is AccountsReport {
  return (
    typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, "accounts"))
  );
}

/**
 * Runs `kms accounts --json` with the given checks, and returns its report and what it printed on
 * standard output and standard error. Both are captured while the task runs.
 */
async function accounts(
  hre: HardhatRuntimeEnvironment,
  checks: { balances: boolean; checkSign: boolean },
): Promise<{ success: boolean; report: AccountsReport; printed: string; stderr: string }> {
  let printed = "";
  let stderr = "";
  const write = mock.method(process.stdout, "write", (chunk: unknown) => {
    printed += String(chunk);
    return true;
  });
  const writeError = mock.method(process.stderr, "write", (chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  let result: unknown;
  try {
    result = await hre.tasks
      .getTask(["kms", "accounts"])
      .run({ json: true, showIds: false, ...checks });
  } finally {
    write.mock.restore();
    writeError.mock.restore();
  }
  assert.ok(isResult(result, isReport, isReport), "kms accounts returns a Result of a report");
  return {
    success: result.success,
    report: result.success ? result.value : result.error,
    printed,
    stderr,
  };
}

describe(onFork ? "kms accounts live on a Sepolia fork" : "kms accounts live on Sepolia", () => {
  let proxy: RecordingProxy | undefined;
  let fork: AnvilFork | undefined;

  before(async () => {
    if (configured.length === 0 || !onFork) {
      return;
    }
    await redacted(async () => {
      const binary = findAnvil(process.env);
      if (binary === undefined) {
        assert.fail(
          `fork mode needs anvil, from Foundry (https://getfoundry.sh), on PATH or in ~/.foundry/bin. ` +
            `To run on Sepolia instead, set ${MODE_VARIABLE}=sepolia.`,
        );
      }
      proxy = await startRecordingProxy(rpcUrl === "" ? DEFAULT_RPC_URL : rpcUrl);
      fork = await startAnvilFork({ binary, forkUrl: proxy.url, hardfork: "prague" });
    });
  });

  after(async () => {
    await fork?.close();
    await proxy?.close();
  });

  for (const provider of PROVIDERS) {
    const skip = configured.includes(provider) ? false : `${provider.variable} is not set`;
    it(
      `${provider.name}: --balances --check-sign shows the balance and a passed sign check`,
      { skip },
      async (t) => {
        await redacted(async () => {
          // Fail closed: fork mode never falls back to the Sepolia RPC.
          if (onFork && fork === undefined) {
            assert.fail("fork mode has no fork URL");
          }
          const hre = await runtime(provider, fork?.url ?? "");

          // The address, from the plain listing, to fund it on the fork.
          const plain = await accounts(hre, { balances: false, checkSign: false });
          const [listed] = plain.report.accounts;
          assert.equal(plain.success, true, listed?.error ?? "kms accounts failed");
          assert.ok(listed?.address !== null && listed?.address !== undefined, "no address");
          const account = getAddress(listed.address);
          assert.equal("balance" in listed, false, "balance without --balances");
          assert.equal("signCheck" in listed, false, "signCheck without --check-sign");

          if (onFork) {
            const connection = await hre.network.create(provider.name);
            try {
              // Only anvil takes anvil_setBalance, so an RPC that is not the fork fails here.
              const client: unknown = await connection.provider.request({
                method: "web3_clientVersion",
              });
              assert.ok(
                typeof client === "string" && client.startsWith("anvil/"),
                "fork mode is not talking to anvil",
              );
              await connection.provider.request({
                method: "anvil_setBalance",
                params: [account, toHex(FORK_BALANCE)],
              });
            } finally {
              await connection.close();
            }
          }

          const run = await accounts(hre, { balances: true, checkSign: true });
          const [entry] = run.report.accounts;
          assert.equal(run.report.version, 1);
          assert.equal(run.report.accounts.length, 1);
          assert.equal(run.success, true, entry?.error ?? "kms accounts failed");
          assert.equal(entry?.address, account);
          assert.equal(entry?.signCheck, "ok");
          assert.equal(entry?.error, null);
          if (onFork) {
            assert.equal(entry?.balance, FORK_BALANCE.toString());
          } else {
            assert.match(entry?.balance ?? "", /^[0-9]+$/);
          }
          // The check signs a message, but its signature is never printed or returned.
          assert.doesNotMatch(run.printed, SIGNATURE_HEX, "standard output holds a signature");
          assert.doesNotMatch(run.stderr, SIGNATURE_HEX, "standard error holds a signature");
          assert.doesNotMatch(JSON.stringify(run.report), SIGNATURE_HEX);
          t.diagnostic(
            `${provider.name}: ${account} holds ${entry?.balance ?? "?"} wei${onFork ? " on the fork" : ""}, sign check ok`,
          );
        });
      },
    );
  }

  // As in the matrix's fork run: anvil's only way to Sepolia is the proxy, which refuses anything
  // but the reads anvil's fork backend makes.
  const skipProxy = !onFork
    ? "runs only in fork mode"
    : configured.length === 0
      ? "no provider is configured"
      : false;
  it("fork: the proxy refused nothing", { skip: skipProxy }, (t) => {
    assert.ok(proxy !== undefined, "the proxy did not start");
    assert.deepEqual(proxy.refused(), [], "the proxy refused a request from anvil");
    t.diagnostic(
      `upstream methods: ${[...proxy.methods()].map(([method, count]) => `${method} ${count}`).join(", ")}`,
    );
  });
});
