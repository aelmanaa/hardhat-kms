// The live check of connection.kms.getAccount, run by `pnpm run test:live` next to the transaction
// matrix. For each provider whose key variable is set, it gets the library account of the key on
// an http network, and sends through a viem wallet client built with it.
//
// In fork mode (the default), it starts its own anvil fork of Sepolia behind the recording proxy,
// funds the account with `anvil_setBalance`, then: signs a message and typed data and recovers
// them; sends an EIP-1559 transfer from the account; and signs an EIP-7702 authorization that
// a throwaway local account sends in a type 4 transaction (the sponsored case), after which the
// account's code is the delegation. Both accounts are funded with `anvil_setBalance`. With
// HARDHAT_KMS_LIVE_NETWORK=sepolia, it checks that the account has no code (a delegation would
// run on the transfer to itself), then sends one EIP-1559 transaction of 0 wei from each account
// to itself, and signs nothing else. A receipt that does not arrive in time fails with the
// transaction's hash and nonce. The key variables and HARDHAT_KMS_LIVE_SOURCE are those of `sepolia.live.test.ts`. Key ids,
// URLs and signed data are redacted from every failure.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { KmsKeyUserConfig } from "hardhat-kms/types";
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  getAddress,
  type Hash,
  parseEther,
  type PublicClient,
  recoverMessageAddress,
  recoverTypedDataAddress,
  toHex,
  WaitForTransactionReceiptTimeoutError,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { SEPOLIA_CHAIN_ID } from "./cases.ts";
import { type AnvilFork, findAnvil, startAnvilFork } from "./helpers/anvil.ts";
import { liveMode, MODE_VARIABLE } from "./helpers/mode.ts";
import { livePackages, registryCheck } from "./helpers/packages.ts";
import { redact } from "./helpers/redact.ts";
import { type RecordingProxy, startRecordingProxy } from "./helpers/rpc-proxy.ts";

const mode = liveMode(process.env);
const onFork = mode === "fork";
/** The provider plugins: the checkout's, or the published ones in registry mode. */
const packages = await livePackages(process.env);

/** Used when HARDHAT_KMS_LIVE_SEPOLIA_RPC_URL is not set. Needs no API key. */
const DEFAULT_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const RPC_VARIABLE = "HARDHAT_KMS_LIVE_SEPOLIA_RPC_URL";
/** What `anvil_setBalance` gives each account on the fork. */
const FORK_BALANCE = parseEther("1");
/** How long to wait for a receipt: a fork mines at once, Sepolia every 12 seconds. */
const RECEIPT_TIMEOUT_MS = onFork ? 30_000 : 300_000;
/**
 * A throwaway local account that sponsors the EIP-7702 transaction on the fork, funded by the test.
 * Not one of anvil's dev accounts: on a Sepolia fork they carry their Sepolia state, which can
 * include a delegation.
 */
const SPONSOR = privateKeyToAccount(generatePrivateKey());
/** The code the account delegates to on the fork. An address without code is a valid delegate. */
const DELEGATE: Address = "0x000000000000000000000000000000000000dEaD";
const CHAIN = defineChain({
  id: SEPOLIA_CHAIN_ID,
  name: "Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

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

/**
 * Waits for a receipt, and on timeout fails with the hash and nonce, so the transaction can be
 * found or replaced by hand.
 */
async function receiptOf(client: PublicClient, hash: Hash, nonce: number | undefined) {
  try {
    return await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof WaitForTransactionReceiptTimeoutError) {
      return assert.fail(
        `no receipt after ${RECEIPT_TIMEOUT_MS / 1000} s for transaction ${hash}, nonce ${nonce ?? "unknown"}`,
      );
    }
    throw error;
  }
}

/** A runtime with one http network for the provider. */
async function runtime(provider: Provider, url: string): Promise<HardhatRuntimeEnvironment> {
  return await createHardhatRuntimeEnvironment(
    {
      plugins: [packages.aws, packages.gcp, packages.azure],
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
    packages.root,
  );
}

describe(
  onFork
    ? "connection.kms.getAccount live on a Sepolia fork"
    : "connection.kms.getAccount live on Sepolia",
  () => {
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
        `${provider.name}: a viem wallet client sends with the account${onFork ? ", and a sponsor sends its authorization" : ""}`,
        { skip },
        async (t) => {
          await redacted(async () => {
            // Fail closed: fork mode never falls back to the Sepolia RPC.
            if (onFork && fork === undefined) {
              assert.fail("fork mode has no fork URL");
            }
            const hre = await runtime(provider, fork?.url ?? "");
            const connection = await hre.network.create(provider.name);
            try {
              const accounts: unknown = await connection.provider.request({
                method: "eth_accounts",
              });
              assert.ok(Array.isArray(accounts) && typeof accounts[0] === "string", "no account");
              const address = getAddress(accounts[0]);
              const account = await connection.kms.getAccount(address);
              assert.equal(account.address, address);
              assert.equal("sign" in account, false);

              const transport = custom(connection.provider);
              const publicClient = createPublicClient({ chain: CHAIN, transport });
              const wallet = createWalletClient({ account, chain: CHAIN, transport });

              if (onFork) {
                // Only anvil takes anvil_setBalance, so an RPC that is not the fork fails here.
                const client: unknown = await connection.provider.request({
                  method: "web3_clientVersion",
                });
                assert.ok(
                  typeof client === "string" && client.startsWith("anvil/"),
                  "fork mode is not talking to anvil",
                );
                for (const funded of [address, SPONSOR.address]) {
                  await connection.provider.request({
                    method: "anvil_setBalance",
                    params: [funded, toHex(FORK_BALANCE)],
                  });
                }

                const message = "hardhat-kms getAccount live check";
                const signature = await account.signMessage({ message });
                assert.equal(await recoverMessageAddress({ message, signature }), address);
                const typedData = {
                  domain: { name: "hardhat-kms", version: "1", chainId: SEPOLIA_CHAIN_ID },
                  types: { Check: [{ name: "account", type: "address" }] },
                  primaryType: "Check",
                  message: { account: address },
                } as const;
                const typedSignature = await account.signTypedData(typedData);
                assert.equal(
                  await recoverTypedDataAddress({ ...typedData, signature: typedSignature }),
                  address,
                );
              }

              if (!onFork) {
                // On Sepolia the transfer goes to the account itself, which would run a
                // delegation's code; a delegation left by an earlier run must be cleared first.
                const code = await publicClient.getCode({ address });
                assert.ok(
                  code === undefined || code === "0x",
                  `${address} has code (${code}), such as an EIP-7702 delegation: clear the delegation first, with an authorization to the zero address`,
                );
              }

              // An EIP-1559 transaction: on the fork a transfer of 1 wei to the sponsor, on
              // Sepolia 0 wei to the account itself. The nonce is set, so that a timeout can name it.
              const nonce = await publicClient.getTransactionCount({
                address,
                blockTag: "pending",
              });
              const hash = await wallet.sendTransaction({
                to: onFork ? SPONSOR.address : address,
                value: onFork ? 1n : 0n,
                nonce,
              });
              const receipt = await receiptOf(publicClient, hash, nonce);
              assert.equal(receipt.status, "success");
              assert.equal(getAddress(receipt.from), address);
              assert.equal(receipt.type, "eip1559");
              t.diagnostic(`${provider.name}: EIP-1559 transaction ${hash} from ${address}`);

              if (onFork) {
                const authorization = await wallet.signAuthorization({ contractAddress: DELEGATE });
                assert.equal(authorization.chainId, SEPOLIA_CHAIN_ID);
                const sponsor = createWalletClient({ account: SPONSOR, chain: CHAIN, transport });
                const sponsored = await sponsor.sendTransaction({
                  authorizationList: [authorization],
                  to: address,
                  data: "0x",
                });
                const sponsoredReceipt = await receiptOf(publicClient, sponsored, undefined);
                assert.equal(sponsoredReceipt.status, "success");
                assert.equal(sponsoredReceipt.type, "eip7702");
                assert.equal(getAddress(sponsoredReceipt.from), SPONSOR.address);
                assert.equal(
                  await publicClient.getCode({ address }),
                  `0xef0100${DELEGATE.slice(2).toLowerCase()}`,
                );
                t.diagnostic(
                  `${provider.name}: EIP-7702 transaction ${sponsored} from the sponsor delegates ${address}`,
                );
              }
            } finally {
              await connection.close();
            }
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

    registryCheck(packages, configured.length);
  },
);
