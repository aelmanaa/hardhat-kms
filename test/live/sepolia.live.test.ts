// The live tests on Sepolia: `pnpm run test:live`. For each provider whose key variable is set,
// it deploys a contract from the KMS account through the plugin, sends one transaction of each
// type (legacy, EIP-2930, EIP-1559 and EIP-7702), and checks a `personal_sign` and an
// `eth_signTypedData_v4` signature on chain with `ecrecover`. A run that delegated the account, or
// found it delegated, ends by clearing the delegation and sending 1 wei to the account. Providers
// without a key are skipped and reported; the configured ones run in parallel.
//
// - HARDHAT_KMS_LIVE_AWS_KEY_ID: an ECC_SECG_P256K1 key id, alias or ARN. AWS_REGION, or the key's
//   ARN, gives the region.
// - HARDHAT_KMS_LIVE_GCP_KEY: the full name of an EC_SIGN_SECP256K1_SHA256 key version.
// - HARDHAT_KMS_LIVE_AZURE_KEY_ID: the versioned URL of a P-256K key.
// - HARDHAT_KMS_LIVE_SEPOLIA_RPC_URL: optional; a public RPC without an API key is the default.
//
// The tests use the developer's own cloud logins and create no cloud resources. Each account must
// hold at least MIN_BALANCE, and the gas price must be at most MAX_GAS_PRICE, or the test fails
// before sending anything. Key ids, resource names and URLs are redacted from every failure.
import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import hardhatViem from "@nomicfoundation/hardhat-viem";
import type { KmsKeyConfig, KmsKeyUserConfig } from "hardhat-kms/types";
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import {
  type Address,
  encodeFunctionData,
  formatEther,
  formatGwei,
  getAddress,
  type Hash,
  type Hex,
  hexToBytes,
  isHex,
  parseEther,
  parseGwei,
  parseSignature,
  toHex,
  zeroAddress,
} from "viem";

// The EIP-7702 authorizations are signed by the core signer loaded from `src`, while the
// transactions go through the plugin built in `dist`. The plugin has no public way to sign an
// authorization yet; switch to it once #35 adds one.
// The provider plugins come from their `src`, so their types resolve before any package is built,
// as in the lint job.
import hardhatKmsAws from "../../packages/hardhat-kms-aws/src/index.ts";
import hardhatKmsAzure from "../../packages/hardhat-kms-azure/src/index.ts";
import hardhatKmsGcp from "../../packages/hardhat-kms-gcp/src/index.ts";
import { authorizationDigest } from "../../packages/hardhat-kms/src/internal/crypto/digests.ts";
import { KmsSigner } from "../../packages/hardhat-kms/src/internal/signer/kms-signer.ts";
import { redact } from "./helpers/redact.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture-project");

const SEPOLIA_CHAIN_ID = 11_155_111;
/** Used when HARDHAT_KMS_LIVE_SEPOLIA_RPC_URL is not set. Needs no API key. */
const DEFAULT_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const RPC_VARIABLE = "HARDHAT_KMS_LIVE_SEPOLIA_RPC_URL";
/** A run spends well under this; an account with less is refused before any transaction. */
const MIN_BALANCE = parseEther("0.01");
/** Above this gas price the test refuses to send, so a fee spike cannot drain the accounts. */
const MAX_GAS_PRICE = parseGwei("20");
/** Code of an account with no delegation, as viem returns it. */
const NO_CODE = [undefined, "0x"];

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

/** The ABI of `fixture-project/contracts/LiveCheck.sol`. */
const LIVE_CHECK_ABI = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
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
  {
    type: "function",
    name: "recoverPersonal",
    stateMutability: "pure",
    inputs: [
      { name: "message", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "recoverCheck",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "value", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/** The storage slot of `count`; `owner` is immutable and takes none. */
const COUNT_SLOT = toHex(0, { size: 32 });

/** One mined transaction, as `docs/live-proof.md` records it. */
interface Sent {
  label: string;
  type: string;
  hash: Hash;
  block: bigint;
}

async function runtime(): Promise<HardhatRuntimeEnvironment> {
  const url = rpcUrl === "" ? DEFAULT_RPC_URL : configVariable(RPC_VARIABLE);
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

/** An EIP-7702 authorization in JSON-RPC form, as Hardhat's request schema takes it. */
interface RpcAuthorization {
  chainId: Hex;
  address: Address;
  nonce: Hex;
  yParity: Hex;
  r: Hex;
  s: Hex;
}

/** One authorization for the account, signed through the core signer. */
async function authorize(
  signer: KmsSigner,
  delegate: Address,
  nonce: number,
): Promise<RpcAuthorization> {
  const signature = await signer.signDigest(
    authorizationDigest({
      chainId: BigInt(SEPOLIA_CHAIN_ID),
      address: hexToBytes(delegate),
      nonce: BigInt(nonce),
    }),
  );
  // r and s stay 32 bytes. viem would send them as quantities without leading zeros, which
  // Hardhat's request schema (and so the plugin) refuses for about one signature in 128.
  return {
    chainId: toHex(SEPOLIA_CHAIN_ID),
    address: delegate,
    nonce: toHex(nonce),
    yParity: toHex(signature.yParity),
    r: toHex(signature.r, { size: 32 }),
    s: toHex(signature.s, { size: 32 }),
  };
}

const errorText = (error: Error): string => `${error.name}: ${error.message}`;

/** Runs one provider's checks on Sepolia, and reports what it sent as test diagnostics. */
async function runProvider(
  hre: HardhatRuntimeEnvironment,
  provider: Provider,
  t: TestContext,
): Promise<void> {
  const signer = await coreSigner(hre, keyOf(hre, provider.name));
  try {
    const account = getAddress(await signer.getAddress());
    const { viem, provider: rpc } = await hre.network.create(provider.name);
    const publicClient = await viem.getPublicClient();
    const wallet = await viem.getWalletClient(account);
    const sent: Sent[] = [];

    assert.equal(await publicClient.getChainId(), SEPOLIA_CHAIN_ID, "the RPC is not Sepolia");
    const accounts: unknown = await rpc.request({ method: "eth_accounts" });
    assert.ok(
      Array.isArray(accounts) &&
        accounts.some((item) => typeof item === "string" && getAddress(item) === account),
      "eth_accounts does not list the KMS account",
    );
    const balance = await publicClient.getBalance({ address: account });
    if (balance < MIN_BALANCE) {
      assert.fail(
        `${account} holds ${formatEther(balance)} ETH, below the floor of ${formatEther(MIN_BALANCE)} ETH. ` +
          "Fund it with Sepolia ETH and run again.",
      );
    }
    const gasPrice = await publicClient.getGasPrice();
    if (gasPrice > MAX_GAS_PRICE) {
      assert.fail(
        `the gas price is ${formatGwei(gasPrice)} gwei, above the cap of ${formatGwei(MAX_GAS_PRICE)} gwei. ` +
          "Run again when Sepolia is cheaper.",
      );
    }
    t.diagnostic(
      `${provider.name}: ${account} holds ${formatEther(balance)} ETH, gas price ${formatGwei(gasPrice)} gwei`,
    );

    /** Waits for a transaction and checks it succeeded, from the KMS account, with this type. */
    const mined = async (label: string, type: string, hash: Hash): Promise<void> => {
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 300_000 });
      assert.equal(receipt.status, "success", `${label} reverted (${hash})`);
      assert.equal(getAddress(receipt.from), account, `${label} was not sent by the KMS account`);
      assert.equal(receipt.type, type, `${label} is not ${type}`);
      sent.push({ label, type, hash, block: receipt.blockNumber });
      t.diagnostic(`${provider.name}: ${label} ${type} ${hash} block ${receipt.blockNumber}`);
    };
    /**
     * Sends an EIP-7702 transaction through the plugin with `eth_sendTransaction`, passing the
     * authorization in the form {@link authorize} builds. The nonce is explicit, so the
     * authorization's nonce (this one + 1) matches the transaction's.
     */
    const sendSetCode = async (request: {
      from: Address;
      to: Address;
      nonce: Hex;
      data?: Hex;
      authorizationList: RpcAuthorization[];
    }): Promise<Hash> => {
      const hash: unknown = await rpc.request({ method: "eth_sendTransaction", params: [request] });
      assert.ok(isHex(hash) && hash.length === 66, "eth_sendTransaction returned no hash");
      return hash;
    };
    const nextNonce = async (): Promise<number> =>
      await publicClient.getTransactionCount({ address: account, blockTag: "pending" });

    // An account left delegated by an earlier run is cleared at the end too.
    let delegated = !NO_CODE.includes(await publicClient.getCode({ address: account }));

    /**
     * Clears the delegation with an authorization to the zero address, checks the account has no
     * code, and sends it 1 wei, which a delegation without `receive` would refuse.
     */
    const clear = async (): Promise<void> => {
      const nonce = await nextNonce();
      await mined(
        "clear the delegation",
        "eip7702",
        await sendSetCode({
          from: account,
          to: account,
          nonce: toHex(nonce),
          authorizationList: [await authorize(signer, zeroAddress, nonce + 1)],
        }),
      );
      assert.ok(
        NO_CODE.includes(await publicClient.getCode({ address: account })),
        "the account still has code after clearing its delegation",
      );
      await mined(
        "send 1 wei to itself",
        "eip1559",
        await wallet.sendTransaction({ to: account, value: 1n }),
      );
    };

    let failure: Error | undefined;
    try {
      const { bytecode } = await hre.artifacts.readArtifact("LiveCheck");
      assert.ok(isHex(bytecode) && bytecode.length > 2, "LiveCheck has no bytecode");
      const deployHash = await wallet.deployContract({ abi: LIVE_CHECK_ABI, bytecode });
      await mined("deploy LiveCheck", "eip1559", deployHash);
      const deployReceipt = await publicClient.getTransactionReceipt({ hash: deployHash });
      const contract = deployReceipt.contractAddress;
      assert.ok(contract !== null && contract !== undefined, "the deployment created no contract");
      const count = async (at: Address = contract): Promise<bigint> =>
        await publicClient.readContract({
          address: at,
          abi: LIVE_CHECK_ABI,
          functionName: "count",
        });
      assert.equal(
        await publicClient.readContract({
          address: contract,
          abi: LIVE_CHECK_ABI,
          functionName: "owner",
        }),
        account,
        "the contract's owner is not the KMS account",
      );

      // `add` succeeds only from the owner, so each write also shows who sent it.
      const add = {
        address: contract,
        abi: LIVE_CHECK_ABI,
        functionName: "add",
        args: [1n],
      } as const;
      const legacyHash = await wallet.writeContract({ ...add, gasPrice });
      await mined("add(1)", "legacy", legacyHash);
      // EIP-155: a legacy transaction signs over the chain id, which its v carries as
      // chainId * 2 + 35 or 36. Some nodes also return the chain id itself.
      const legacy = await publicClient.getTransaction({ hash: legacyHash });
      assert.equal(
        (legacy.v - 35n) / 2n,
        BigInt(SEPOLIA_CHAIN_ID),
        `the legacy transaction's v (${legacy.v}) does not carry chain id ${SEPOLIA_CHAIN_ID}`,
      );
      if (legacy.chainId !== undefined) {
        assert.equal(
          legacy.chainId,
          SEPOLIA_CHAIN_ID,
          "the legacy transaction has another chain id",
        );
      }
      await mined(
        "add(1) with an access list",
        "eip2930",
        await wallet.writeContract({
          ...add,
          gasPrice,
          accessList: [{ address: contract, storageKeys: [COUNT_SLOT] }],
        }),
      );
      await mined("add(1)", "eip1559", await wallet.writeContract(add));
      assert.equal(await count(), 3n, "the contract did not count three writes");

      // EIP-7702: the account delegates to LiveCheck and calls `add` on itself in the same
      // transaction. It sends the transaction too, so the authorization takes the nonce after it.
      const nonce = await nextNonce();
      // The account's own slot 0, which an earlier run's delegated `add` may have left non-zero.
      const countBefore = BigInt(
        (await publicClient.getStorageAt({ address: account, slot: COUNT_SLOT })) ?? 0n,
      );
      const authorization = await authorize(signer, contract, nonce + 1);
      delegated = true;
      await mined(
        "delegate to LiveCheck and add(1)",
        "eip7702",
        await sendSetCode({
          from: account,
          to: account,
          nonce: toHex(nonce),
          data: encodeFunctionData({ abi: LIVE_CHECK_ABI, functionName: "add", args: [1n] }),
          authorizationList: [authorization],
        }),
      );
      assert.equal(
        (await publicClient.getCode({ address: account }))?.toLowerCase(),
        `0xef0100${contract.slice(2).toLowerCase()}`,
        "the account does not delegate to LiveCheck",
      );
      assert.equal(await count(account), countBefore + 1n, "the delegated add did not run");

      // Signatures checked by the contract: it rebuilds both digests and calls ecrecover.
      const message = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const personal = parseSignature(await wallet.signMessage({ message: { raw: message } }));
      assert.equal(
        await publicClient.readContract({
          address: contract,
          abi: LIVE_CHECK_ABI,
          functionName: "recoverPersonal",
          args: [message, Number(personal.v), personal.r, personal.s],
        }),
        account,
        "personal_sign does not recover to the KMS account on chain",
      );
      const typed = parseSignature(
        await wallet.signTypedData({
          domain: {
            name: "hardhat-kms live",
            version: "1",
            chainId: SEPOLIA_CHAIN_ID,
            verifyingContract: contract,
          },
          types: {
            Check: [
              { name: "account", type: "address" },
              { name: "count", type: "uint256" },
            ],
          },
          primaryType: "Check",
          message: { account, count: 3n },
        }),
      );
      assert.equal(
        await publicClient.readContract({
          address: contract,
          abi: LIVE_CHECK_ABI,
          functionName: "recoverCheck",
          args: [account, 3n, Number(typed.v), typed.r, typed.s],
        }),
        account,
        "eth_signTypedData_v4 does not recover to the KMS account on chain",
      );
      t.diagnostic(`${provider.name}: LiveCheck ${contract}`);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }

    // Always clear a delegation, even after a failure: the account must stay a plain account.
    if (delegated) {
      try {
        await clear();
      } catch (error) {
        const cleared = error instanceof Error ? error : new Error(String(error));
        failure =
          failure === undefined
            ? cleared
            : new Error(
                `${errorText(failure)}; clearing the delegation also failed: ${errorText(cleared)}`,
              );
      }
    }
    if (failure !== undefined) {
      throw failure;
    }

    t.diagnostic(
      `${provider.name}: proof ${JSON.stringify({
        provider: provider.name,
        chainId: SEPOLIA_CHAIN_ID,
        account,
        transactions: sent.map((item) => ({ ...item, block: item.block.toString() })),
        spent: formatEther(balance - (await publicClient.getBalance({ address: account }))),
      })}`,
    );
  } finally {
    await signer.close();
  }
}

describe("live on Sepolia", { concurrency: true, timeout: 1_800_000 }, () => {
  let hre: HardhatRuntimeEnvironment;

  before(async () => {
    if (configured.length > 0) {
      await redacted(async () => {
        hre = await runtime();
        await hre.tasks.getTask("build").run({ quiet: true });
      });
    }
  });

  for (const provider of PROVIDERS) {
    const skip = configured.includes(provider) ? false : `${provider.variable} is not set`;
    it(
      `${provider.name}: deploys, sends every transaction type and verifies signatures`,
      { skip },
      async (t) => {
        await redacted(async () => {
          await runProvider(hre, provider, t);
        });
      },
    );
  }
});
