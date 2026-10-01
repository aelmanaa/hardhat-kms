// The live tests: `pnpm run test:live`. For each provider whose key variable is set, it deploys a
// contract from the KMS account through the plugin, sends one transaction of each type (legacy,
// EIP-2930, EIP-1559 and EIP-7702), and checks a `personal_sign` and an `eth_signTypedData_v4`
// signature on chain with `ecrecover`. A run that delegated the account, or found it delegated,
// ends by clearing the delegation and sending 1 wei to the account. Providers without a key are
// skipped and reported; the configured ones run in parallel.
//
// By default the suite runs on a local anvil fork of Sepolia, with each account funded by
// `anvil_setBalance`: it signs with the real keys and spends nothing. Anvil reads Sepolia through
// a proxy that refuses and records any send, and the run fails if one was attempted.
// HARDHAT_KMS_LIVE_NETWORK=sepolia runs it on Sepolia itself, which spends Sepolia ETH and
// produces the hashes for `docs/live-proof.md`.
//
// - HARDHAT_KMS_LIVE_AWS_KEY_ID: an ECC_SECG_P256K1 key id, alias or ARN. AWS_REGION, or the key's
//   ARN, gives the region.
// - HARDHAT_KMS_LIVE_GCP_KEY: the full name of an EC_SIGN_SECP256K1_SHA256 key version.
// - HARDHAT_KMS_LIVE_AZURE_KEY_ID: the versioned URL of a P-256K key.
// - HARDHAT_KMS_LIVE_SEPOLIA_RPC_URL: optional; a public RPC without an API key is the default.
//
// The tests use the developer's own cloud logins and create no cloud resources. Each account must
// hold at least MIN_BALANCE, and on Sepolia the legacy gas price must be at most MAX_GAS_PRICE, or
// the test fails before sending anything. Key ids, resource names, URLs and signed data are
// redacted from every failure.
import assert from "node:assert/strict";
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
  type TransactionReceipt,
  WaitForTransactionReceiptTimeoutError,
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
import { type AnvilFork, findAnvil, startAnvilFork } from "./helpers/anvil.ts";
import { legacyGasPrice } from "./helpers/gas.ts";
import { liveMode, MODE_VARIABLE } from "./helpers/mode.ts";
import { redact } from "./helpers/redact.ts";
import { retryLagging } from "./helpers/retry.ts";
import { type RecordingProxy, startRecordingProxy } from "./helpers/rpc-proxy.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture-project");

/** Where the transactions go; throws at load on a value other than `fork` or `sepolia`. */
const onFork = liveMode(process.env) === "fork";

const SEPOLIA_CHAIN_ID = 11_155_111;
/** Used when HARDHAT_KMS_LIVE_SEPOLIA_RPC_URL is not set. Needs no API key. */
const DEFAULT_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const RPC_VARIABLE = "HARDHAT_KMS_LIVE_SEPOLIA_RPC_URL";
/** A run spends well under this; an account with less is refused before any transaction. */
const MIN_BALANCE = parseEther("0.01");
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

/**
 * The runtime, with one http network per configured provider.
 *
 * @param forkUrl - The anvil fork's URL in fork mode; the Sepolia RPC is used without it.
 */
async function runtime(forkUrl?: string): Promise<HardhatRuntimeEnvironment> {
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

/** Runs one provider's checks, and reports what it sent as test diagnostics. */
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
    const balance = await publicClient.getBalance({ address: account });
    if (balance < MIN_BALANCE) {
      assert.fail(
        `${account} holds ${formatEther(balance)} ETH, below the floor of ${formatEther(MIN_BALANCE)} ETH. ` +
          "Fund it with Sepolia ETH and run again.",
      );
    }
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
    t.diagnostic(
      `${provider.name}: ${account} holds ${formatEther(balance)} ETH${onFork ? " on the fork" : ""}, ` +
        `legacy gas price ${formatGwei(gasPrice)} gwei`,
    );

    // The block of the latest receipt. Reads that check state after a write ask for this block, so
    // a node behind the public RPC that has not reached it answers "header not found", which
    // retryLagging waits out, instead of returning stale state.
    let lastBlock: bigint | undefined;

    /**
     * Waits for a transaction and checks it succeeded, from the KMS account, with this type. A
     * lagging node only delays the wait: viem keeps polling until a node returns the receipt.
     *
     * @returns The receipt's block and created contract.
     */
    const mined = async (
      label: string,
      type: string,
      hash: Hash,
    ): Promise<{ block: bigint; contractAddress: Address | null | undefined }> => {
      const waitFor = async (timeout: number): Promise<TransactionReceipt | undefined> => {
        try {
          return await publicClient.waitForTransactionReceipt({ hash, timeout });
        } catch (error) {
          if (error instanceof WaitForTransactionReceiptTimeoutError) {
            return undefined;
          }
          throw error;
        }
      };
      let receipt = await waitFor(onFork ? FORK_NUDGE_MS : RECEIPT_TIMEOUT_MS);
      if (receipt === undefined && onFork) {
        // Anvil mines on each transaction it receives, but under concurrent sends it has once left
        // a valid transaction pending with no later send to trigger a block. One more block takes
        // it; a transaction that is not valid stays out and fails below as on Sepolia.
        await rpc.request({ method: "evm_mine" });
        t.diagnostic(`${provider.name}: ${label} was still pending; mined a block with evm_mine`);
        receipt = await waitFor(RECEIPT_TIMEOUT_MS - FORK_NUDGE_MS);
      }
      if (receipt === undefined) {
        const nonce = await publicClient
          .getTransaction({ hash })
          .then((tx) => String(tx.nonce))
          .catch(() => "unknown");
        const count = await publicClient
          .getTransactionCount({ address: account, blockTag: "latest" })
          .then(String)
          .catch(() => "unknown");
        return assert.fail(
          `${label} was not mined within ${RECEIPT_TIMEOUT_MS / 1000} s: transaction ${hash}, nonce ${nonce}, ` +
            `and the account's mined transaction count is ${count}. ` +
            (onFork
              ? "On the fork this is a test or anvil problem; nothing reached Sepolia."
              : `It may be priced below the base fee. Replace it: send a transaction from ${account} with nonce ` +
                `${nonce} and a higher fee, for example 0 ETH to itself, before running again.`),
        );
      }
      assert.equal(receipt.status, "success", `${label} reverted (${hash})`);
      assert.equal(getAddress(receipt.from), account, `${label} was not sent by the KMS account`);
      assert.equal(receipt.type, type, `${label} is not ${type}`);
      sent.push({ label, type, hash, block: receipt.blockNumber });
      t.diagnostic(`${provider.name}: ${label} ${type} ${hash} block ${receipt.blockNumber}`);
      lastBlock =
        lastBlock === undefined || receipt.blockNumber > lastBlock
          ? receipt.blockNumber
          : lastBlock;
      return { block: receipt.blockNumber, contractAddress: receipt.contractAddress };
    };
    /** The account's code at a receipt's block. */
    const codeAt = async (blockNumber: bigint): Promise<string | undefined> =>
      await retryLagging(async () => await publicClient.getCode({ address: account, blockNumber }));
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
    /**
     * The account's next nonce. Every send is awaited until mined, so after the first receipt it is
     * the count at the latest receipt's block, which a lagging node cannot understate.
     */
    const nextNonce = async (): Promise<number> => {
      const blockNumber = lastBlock;
      return blockNumber === undefined
        ? await publicClient.getTransactionCount({ address: account, blockTag: "pending" })
        : await retryLagging(
            async () => await publicClient.getTransactionCount({ address: account, blockNumber }),
          );
    };

    // An account left delegated by an earlier run is cleared at the end too.
    let delegated = !NO_CODE.includes(await publicClient.getCode({ address: account }));

    /**
     * Clears the delegation with an authorization to the zero address, checks the account has no
     * code, and sends it 1 wei, which a delegation without `receive` would refuse.
     */
    const clear = async (): Promise<void> => {
      const nonce = await nextNonce();
      const { block } = await mined(
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
        NO_CODE.includes(await codeAt(block)),
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
      const deployed = await mined("deploy LiveCheck", "eip1559", deployHash);
      const contract = deployed.contractAddress;
      assert.ok(contract !== null && contract !== undefined, "the deployment created no contract");
      /** `count()` at a receipt's block, on the contract or on the delegated account. */
      const count = async (blockNumber: bigint, at: Address = contract): Promise<bigint> =>
        await retryLagging(
          async () =>
            await publicClient.readContract({
              address: at,
              abi: LIVE_CHECK_ABI,
              functionName: "count",
              blockNumber,
            }),
        );
      assert.equal(
        await retryLagging(
          async () =>
            await publicClient.readContract({
              address: contract,
              abi: LIVE_CHECK_ABI,
              functionName: "owner",
              blockNumber: deployed.block,
            }),
        ),
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
      const third = await mined("add(1)", "eip1559", await wallet.writeContract(add));
      assert.equal(await count(third.block), 3n, "the contract did not count three writes");

      // EIP-7702: the account delegates to LiveCheck and calls `add` on itself in the same
      // transaction. It sends the transaction too, so the authorization takes the nonce after it.
      const nonce = await nextNonce();
      // The account's own slot 0, which an earlier run's delegated `add` may have left non-zero.
      const countBefore = BigInt(
        (await retryLagging(
          async () =>
            await publicClient.getStorageAt({
              address: account,
              slot: COUNT_SLOT,
              blockNumber: third.block,
            }),
        )) ?? 0n,
      );
      const authorization = await authorize(signer, contract, nonce + 1);
      delegated = true;
      const delegation = await mined(
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
        (await codeAt(delegation.block))?.toLowerCase(),
        `0xef0100${contract.slice(2).toLowerCase()}`,
        "the account does not delegate to LiveCheck",
      );
      assert.equal(
        await count(delegation.block, account),
        countBefore + 1n,
        "the delegated add did not run",
      );

      // Signatures checked by the contract: it rebuilds both digests and calls ecrecover. The calls
      // ask for a block the contract exists at, so a lagging node cannot answer from before it.
      const message = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const personal = parseSignature(await wallet.signMessage({ message: { raw: message } }));
      assert.equal(
        await retryLagging(
          async () =>
            await publicClient.readContract({
              address: contract,
              abi: LIVE_CHECK_ABI,
              functionName: "recoverPersonal",
              args: [message, Number(personal.v), personal.r, personal.s],
              blockNumber: delegation.block,
            }),
        ),
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
        await retryLagging(
          async () =>
            await publicClient.readContract({
              address: contract,
              abi: LIVE_CHECK_ABI,
              functionName: "recoverCheck",
              args: [account, 3n, Number(typed.v), typed.r, typed.s],
              blockNumber: delegation.block,
            }),
        ),
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

    // A fork run's hashes exist on no public chain, so it reports no proof for docs/live-proof.md.
    if (onFork) {
      t.diagnostic(
        `${provider.name}: fork run passed with ${sent.length} transactions; not a live proof`,
      );
      return;
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
    assert.ok(methods.size > 0, "anvil sent no request through the proxy");
    assert.deepEqual(proxy.refused(), [], "a send reached the proxy, which refused it");
    t.diagnostic(
      `upstream methods: ${[...methods].map(([method, count]) => `${method} ${count}`).join(", ")}`,
    );
  });
});
