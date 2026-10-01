// The steps behind each case of `matrix.ts`, for one provider's run. The suite runs them in the
// order of `CASES`, on Sepolia or on the fork, and checks afterwards that every cell the mode runs
// has a receipt with the case's status, sender and type.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import type { PublicClient, WalletClient } from "@nomicfoundation/hardhat-viem/types";
import type { EthereumProvider } from "hardhat/types/providers";
import {
  type Address,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  type Hash,
  type Hex,
  hexToBytes,
  http,
  isHex,
  parseEther,
  parseGwei,
  parseSignature,
  type PrivateKeyAccount,
  type SignedAuthorization,
  toHex,
  type TransactionReceipt,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  zeroAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { authorizationDigest } from "../../packages/hardhat-kms/src/internal/crypto/digests.ts";
import type { KmsSigner } from "../../packages/hardhat-kms/src/internal/signer/kms-signer.ts";
import type { ProofRecord } from "./helpers/proof.ts";
import { retryLagging } from "./helpers/retry.ts";
import { type Case, CASES, type CaseId } from "./matrix.ts";

export const SEPOLIA_CHAIN_ID = 11_155_111;

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
    stateMutability: "payable",
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
/** Runtime code of the minimal contract: PUSH0 PUSH0 RETURN, which returns nothing. */
const MINIMAL_RUNTIME = "0x5f5ff3";
/** Creation code that copies the 3 bytes after its own 10 and returns them as the runtime code. */
const MINIMAL_INIT: Hex = `0x6003600a5f3960035ff3${MINIMAL_RUNTIME.slice(2)}`;
/** A selector no function of `LiveCheck` has; with no fallback, a call with it reverts. */
const UNKNOWN_SELECTOR = "0xdeadbeef";
/** Code of an account with no delegation, as viem returns it. */
const NO_CODE = [undefined, "0x"];
/** The fork's chain, for the local sender's wallet client. */
const FORK_CHAIN = defineChain({
  id: SEPOLIA_CHAIN_ID,
  name: "Sepolia fork",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

const delegationTo = (address: Address): string => `0xef0100${address.slice(2).toLowerCase()}`;

/** What one provider's run needs from the suite. */
export interface RunOptions {
  provider: string;
  t: TestContext;
  account: Address;
  signer: KmsSigner;
  rpc: EthereumProvider;
  publicClient: PublicClient;
  wallet: WalletClient;
  /** The price the legacy and EIP-2930 transactions pay. */
  gasPrice: bigint;
  /** The anvil URL in fork mode; undefined on Sepolia. */
  forkUrl: string | undefined;
  /** How long to wait for a receipt in total. */
  receiptTimeoutMs: number;
  /** On the fork, how long a transaction may stay pending before the run mines a block. */
  forkNudgeMs: number;
  /** Called each time the fork run mines a block itself. */
  onNudge: () => void;
}

/** One provider's run: its state between cases, and what it recorded. */
export class ProviderRun {
  readonly records: ProofRecord[] = [];
  /** Whether the account may be delegated: set before each send that could delegate it. */
  delegated = false;
  #options: RunOptions;
  /** The block of the latest receipt; reads that check state after a write ask for it. */
  #lastBlock: bigint | undefined;
  /** After a reverted transaction, the nonce the next one must have. */
  #expectNonce: number | undefined;
  #contract: Address | undefined;
  #minimal: Address | undefined;
  /** A fresh address per run, which the transfers to another EOA pay 1 wei each. */
  readonly #recipient: Address;
  #recipientBalance = 0n;
  #contractBalance = 0n;
  #count = 0n;
  /** A key that exists only in memory for this run. It holds no ETH; the KMS account sends. */
  readonly #throwaway: PrivateKeyAccount;
  #throwawayDelegated = false;
  #delegationBlock: bigint | undefined;

  constructor(options: RunOptions) {
    this.#options = options;
    this.#recipient = getAddress(toHex(crypto.getRandomValues(new Uint8Array(20))));
    this.#throwaway = privateKeyToAccount(generatePrivateKey());
  }

  get contract(): Address | undefined {
    return this.#contract;
  }

  get firstBlock(): bigint | undefined {
    const blocks = this.records
      .filter((item) => item.hash !== null)
      .map((item) => BigInt(item.block));
    return blocks.reduce<bigint | undefined>(
      (a, b) => (a === undefined || b < a ? b : a),
      undefined,
    );
  }

  get lastBlock(): bigint | undefined {
    return this.#lastBlock;
  }

  /** Runs one case. */
  async run(id: CaseId): Promise<void> {
    await STEPS[id](this);
  }

  /** Clears whatever the run left delegated: the throwaway key, then the account. */
  async cleanUp(): Promise<void> {
    let failure: Error | undefined;
    if (this.#throwawayDelegated) {
      try {
        await this.#clearThrowaway();
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (this.delegated) {
      await this.run("clear-delegation");
    }
    if (failure !== undefined) {
      throw failure;
    }
  }

  #case(id: CaseId): Case {
    const found: Case | undefined = CASES.find((item) => item.id === id);
    assert.ok(found !== undefined, `no case ${id}`);
    return found;
  }

  #need<T>(value: T | undefined, what: string): T {
    assert.ok(value !== undefined, `${what} is not there: an earlier case did not run`);
    return value;
  }

  /** A transaction by hash, waiting out a node that has not seen it yet. */
  async #transaction(hash: Hash) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#options.publicClient.getTransaction({ hash });
      } catch (error) {
        if (!(error instanceof TransactionNotFoundError) || attempt >= 10) {
          throw error;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 2000);
        });
      }
    }
  }

  /**
   * Waits for a transaction and checks it against its case: status, sender and type. Records it,
   * and after a revert, checks that the next transaction from the account takes the next nonce.
   *
   * @param sender - The account that sent it, when it is not the KMS account.
   */
  async mined(
    id: CaseId,
    label: string,
    hash: Hash,
    sender?: Address,
  ): Promise<TransactionReceipt> {
    const { publicClient, rpc, t, provider, account, forkUrl } = this.#options;
    const item = this.#case(id);
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
    const onFork = forkUrl !== undefined;
    let receipt = await waitFor(
      onFork ? this.#options.forkNudgeMs : this.#options.receiptTimeoutMs,
    );
    if (receipt === undefined && onFork) {
      // Anvil mines on each transaction it receives, but under concurrent sends it has once left a
      // valid transaction pending with no later send to trigger a block. One more block takes it; a
      // transaction that is not valid stays out and fails below as on Sepolia.
      await rpc.request({ method: "evm_mine" });
      this.#options.onNudge();
      t.diagnostic(`${provider}: ${label} was still pending; mined a block with evm_mine`);
      receipt = await waitFor(this.#options.receiptTimeoutMs - this.#options.forkNudgeMs);
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
        `${label} was not mined within ${this.#options.receiptTimeoutMs / 1000} s: transaction ${hash}, ` +
          `nonce ${nonce}, and the account's mined transaction count is ${count}. ` +
          (onFork
            ? "On the fork this is a test or anvil problem; nothing reached Sepolia."
            : `It may be priced below the base fee. Replace it: send a transaction from ${account} with nonce ` +
              `${nonce} and a higher fee, for example 0 ETH to itself, before running again.`),
      );
    }
    this.#lastBlock =
      this.#lastBlock === undefined || receipt.blockNumber > this.#lastBlock
        ? receipt.blockNumber
        : this.#lastBlock;
    const from = sender ?? account;
    assert.equal(
      receipt.status,
      item.expect.status,
      `${label}: status ${receipt.status} (${hash})`,
    );
    assert.equal(getAddress(receipt.from), from, `${label} was not sent by ${from}`);
    assert.equal(receipt.type, item.type, `${label} is not ${item.type ?? "a check"}`);
    if (sender === undefined) {
      const tx = await this.#transaction(hash);
      if (this.#expectNonce !== undefined) {
        assert.equal(
          tx.nonce,
          this.#expectNonce,
          `${label} did not take the nonce after the revert`,
        );
        this.#expectNonce = undefined;
      }
      if (receipt.status === "reverted") {
        // The account's count after the revert: the nonce + 1, or + 2 when the transaction also
        // carried the account's own authorization, which EIP-7702 applies even on a revert.
        this.#expectNonce = await this.#at(
          async (blockNumber) =>
            await publicClient.getTransactionCount({ address: account, blockNumber }),
          receipt.blockNumber,
        );
      }
    }
    this.records.push({
      case: id,
      label,
      type: item.type,
      hash,
      block: receipt.blockNumber.toString(),
      status: receipt.status,
      from: sender === undefined ? "kms" : "other",
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    });
    t.diagnostic(
      `${provider}: ${id}: ${label} ${receipt.type} ${hash} block ${receipt.blockNumber}`,
    );
    return receipt;
  }

  /** Reads at a receipt's block, retried while a lagging node lacks it. */
  async #at<T>(read: (blockNumber: bigint) => Promise<T>, blockNumber: bigint): Promise<T> {
    return await retryLagging(async () => await read(blockNumber));
  }

  async #codeAt(address: Address, blockNumber: bigint): Promise<string | undefined> {
    return await this.#at(
      async (block) => await this.#options.publicClient.getCode({ address, blockNumber: block }),
      blockNumber,
    );
  }

  async #balanceAt(address: Address, blockNumber: bigint): Promise<bigint> {
    return await this.#at(
      async (block) => await this.#options.publicClient.getBalance({ address, blockNumber: block }),
      blockNumber,
    );
  }

  /** `count()` at a block, on the contract or on the delegated account. */
  async #countAt(at: Address, blockNumber: bigint): Promise<bigint> {
    return await this.#at(
      async (block) =>
        await this.#options.publicClient.readContract({
          address: at,
          abi: LIVE_CHECK_ABI,
          functionName: "count",
          blockNumber: block,
        }),
      blockNumber,
    );
  }

  /**
   * The account's next nonce. Every send is awaited until mined, so after the first receipt it is
   * the count at the latest receipt's block, which a lagging node cannot understate.
   */
  async nextNonce(): Promise<number> {
    const { publicClient, account } = this.#options;
    const blockNumber = this.#lastBlock;
    return blockNumber === undefined
      ? await publicClient.getTransactionCount({ address: account, blockTag: "pending" })
      : await retryLagging(
          async () => await publicClient.getTransactionCount({ address: account, blockNumber }),
        );
  }

  /** One authorization by the KMS key, signed through the core signer. */
  async authorize(delegate: Address, nonce: number): Promise<SignedAuthorization> {
    // Every authorization the KMS key signs names Sepolia. Chain id 0 would make it valid on every
    // chain, so the suite never signs one.
    const signature = await this.#options.signer.signDigest(
      authorizationDigest({
        chainId: BigInt(SEPOLIA_CHAIN_ID),
        address: hexToBytes(delegate),
        nonce: BigInt(nonce),
      }),
    );
    return {
      chainId: SEPOLIA_CHAIN_ID,
      address: delegate,
      nonce,
      yParity: signature.yParity,
      r: toHex(signature.r, { size: 32 }),
      s: toHex(signature.s, { size: 32 }),
    };
  }

  async deployLiveCheck(bytecode: Hex): Promise<void> {
    const { wallet, publicClient, account } = this.#options;
    const receipt = await this.mined(
      "deploy-live-check",
      "deploy LiveCheck",
      await wallet.deployContract({ abi: LIVE_CHECK_ABI, bytecode }),
    );
    const contract = receipt.contractAddress;
    assert.ok(contract !== null && contract !== undefined, "the deployment created no contract");
    this.#contract = getAddress(contract);
    assert.equal(
      await this.#at(
        async (blockNumber) =>
          await publicClient.readContract({
            address: getAddress(contract),
            abi: LIVE_CHECK_ABI,
            functionName: "owner",
            blockNumber,
          }),
        receipt.blockNumber,
      ),
      account,
      "the contract's owner is not the KMS account",
    );
  }

  /** 1 wei to the run's fresh address; its balance must grow by 1 at the receipt's block. */
  async payRecipient(id: CaseId, type: "legacy" | "eip2930" | "eip1559"): Promise<void> {
    const { wallet, gasPrice } = this.#options;
    const to = this.#recipient;
    const hash =
      type === "eip1559"
        ? await wallet.sendTransaction({ to, value: 1n })
        : await wallet.sendTransaction({
            to,
            value: 1n,
            gasPrice,
            ...(type === "eip2930" ? { accessList: [{ address: to, storageKeys: [] }] } : {}),
          });
    const receipt = await this.mined(id, "1 wei to a fresh address", hash);
    await this.#checkRecipient(receipt.blockNumber);
  }

  async #checkRecipient(blockNumber: bigint): Promise<void> {
    this.#recipientBalance += 1n;
    assert.equal(
      await this.#balanceAt(this.#recipient, blockNumber),
      this.#recipientBalance,
      "the fresh address did not receive 1 wei",
    );
  }

  /** 1 wei to the account itself. */
  async selfSend(id: CaseId, type: "legacy" | "eip2930" | "eip1559"): Promise<void> {
    const { wallet, gasPrice, account } = this.#options;
    const hash =
      type === "eip1559"
        ? await wallet.sendTransaction({ to: account, value: 1n })
        : await wallet.sendTransaction({
            to: account,
            value: 1n,
            gasPrice,
            ...(type === "eip2930" ? { accessList: [{ address: account, storageKeys: [] }] } : {}),
          });
    await this.mined(id, "1 wei to itself", hash);
  }

  /** Deploys the 3-byte contract and checks its code. */
  async deployMinimal(id: CaseId, type: "legacy" | "eip2930"): Promise<void> {
    const { wallet, gasPrice, account } = this.#options;
    const hash = await wallet.sendTransaction({
      to: null,
      data: MINIMAL_INIT,
      gasPrice,
      ...(type === "eip2930" ? { accessList: [{ address: account, storageKeys: [] }] } : {}),
    });
    const receipt = await this.mined(id, "deploy a 3-byte contract", hash);
    const created = receipt.contractAddress;
    assert.ok(created !== null && created !== undefined, "the deployment created no contract");
    const address = getAddress(created);
    assert.equal(
      await this.#codeAt(address, receipt.blockNumber),
      MINIMAL_RUNTIME,
      "the 3-byte contract has other code",
    );
    this.#minimal ??= address;
  }

  /** `add(1)` with 1 wei: the count and the contract's balance must both grow by 1. */
  async callAdd(id: CaseId, type: "legacy" | "eip2930" | "eip1559"): Promise<void> {
    const { wallet, gasPrice, publicClient } = this.#options;
    const contract = this.#need(this.#contract, "LiveCheck");
    const add = {
      address: contract,
      abi: LIVE_CHECK_ABI,
      functionName: "add",
      args: [1n],
      value: 1n,
    } as const;
    const hash =
      type === "eip1559"
        ? await wallet.writeContract(add)
        : await wallet.writeContract({
            ...add,
            gasPrice,
            ...(type === "eip2930"
              ? { accessList: [{ address: contract, storageKeys: [COUNT_SLOT] }] }
              : {}),
          });
    const receipt = await this.mined(id, "add(1) with 1 wei", hash);
    if (type === "legacy") {
      // EIP-155: a legacy transaction signs over the chain id, which its v carries as
      // chainId * 2 + 35 or 36. Some nodes also return the chain id itself.
      const legacy = await publicClient.getTransaction({ hash });
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
    }
    this.#count += 1n;
    this.#contractBalance += 1n;
    assert.equal(
      await this.#countAt(contract, receipt.blockNumber),
      this.#count,
      "add did not count",
    );
    assert.equal(
      await this.#balanceAt(contract, receipt.blockNumber),
      this.#contractBalance,
      "LiveCheck did not receive the 1 wei",
    );
  }

  /** An unknown selector to `LiveCheck` with an explicit gas limit, mined with status 0. */
  async revert(id: CaseId, type: "legacy" | "eip2930" | "eip1559"): Promise<void> {
    const { wallet, gasPrice } = this.#options;
    const contract = this.#need(this.#contract, "LiveCheck");
    // The gas limit is explicit: an estimate would ask the node, which refuses a reverting call.
    const request = { to: contract, data: UNKNOWN_SELECTOR, gas: 50_000n } as const;
    const hash =
      type === "eip1559"
        ? await wallet.sendTransaction(request)
        : await wallet.sendTransaction({
            ...request,
            gasPrice,
            ...(type === "eip2930" ? { accessList: [{ address: contract, storageKeys: [] }] } : {}),
          });
    await this.mined(id, "an unknown selector to LiveCheck", hash);
  }

  /**
   * Fork only: with automine off, sends a 1 wei self-send, then one with the same nonce and
   * double the fees, mines one block, and checks that only the second was mined.
   */
  async replace(id: CaseId, type: "legacy" | "eip2930" | "eip1559" | "eip7702"): Promise<void> {
    const { wallet, gasPrice, account, rpc, publicClient, forkUrl } = this.#options;
    assert.ok(forkUrl !== undefined, "replacements run only on the fork");
    const nonce = await this.nextNonce();
    const tip = parseGwei("1");
    const send = async (factor: bigint): Promise<Hash> => {
      const base = { to: account, value: 1n, nonce } as const;
      if (type === "legacy") {
        return await wallet.sendTransaction({ ...base, gas: 21_000n, gasPrice: gasPrice * factor });
      }
      if (type === "eip2930") {
        return await wallet.sendTransaction({
          ...base,
          gas: 30_000n,
          gasPrice: gasPrice * factor,
          accessList: [{ address: account, storageKeys: [] }],
        });
      }
      const fees = { maxFeePerGas: (gasPrice + tip) * factor, maxPriorityFeePerGas: tip * factor };
      if (type === "eip1559") {
        return await wallet.sendTransaction({ ...base, ...fees, gas: 21_000n });
      }
      const contract = this.#need(this.#contract, "LiveCheck");
      this.delegated = true;
      return await wallet.sendTransaction({
        ...base,
        ...fees,
        gas: 80_000n,
        authorizationList: [await this.authorize(contract, nonce + 1)],
      });
    };
    let first: Hash | undefined;
    let second: Hash | undefined;
    await rpc.request({ method: "evm_setAutomine", params: [false] });
    try {
      first = await send(1n);
      second = await send(2n);
      assert.notEqual(first, second, "the replacement has the same hash");
      await rpc.request({ method: "evm_mine" });
    } finally {
      await rpc.request({ method: "evm_setAutomine", params: [true] });
    }
    const receipt = await this.mined(id, "replace a pending self-send", second);
    assert.equal(
      (await this.#transaction(second)).nonce,
      nonce,
      "the replacement took another nonce",
    );
    const replaced = first;
    await assert.rejects(
      publicClient.getTransactionReceipt({ hash: replaced }),
      TransactionReceiptNotFoundError,
      "the replaced transaction was mined too",
    );
    if (type === "eip7702") {
      assert.equal(
        (await this.#codeAt(account, receipt.blockNumber))?.toLowerCase(),
        delegationTo(this.#need(this.#contract, "LiveCheck")),
        "the replacement's authorization was not applied",
      );
    }
  }

  /** EIP-7702: delegates the account to `LiveCheck` and calls `add(1)` with 1 wei on itself. */
  async delegateAndCall(): Promise<void> {
    const { wallet, account, publicClient } = this.#options;
    const contract = this.#need(this.#contract, "LiveCheck");
    // The account sends the transaction too, so the authorization takes the nonce after it.
    const nonce = await this.nextNonce();
    const before = this.#need(this.#lastBlock, "a receipt");
    // The account's own slot 0, which an earlier run's delegated `add` may have left non-zero.
    const countBefore = BigInt(
      (await this.#at(
        async (blockNumber) =>
          await publicClient.getStorageAt({ address: account, slot: COUNT_SLOT, blockNumber }),
        before,
      )) ?? 0n,
    );
    const authorization = await this.authorize(contract, nonce + 1);
    this.delegated = true;
    const receipt = await this.mined(
      "delegate-and-call",
      "delegate to LiveCheck and add(1) with 1 wei",
      await wallet.sendTransaction({
        to: account,
        nonce,
        value: 1n,
        data: encodeFunctionData({ abi: LIVE_CHECK_ABI, functionName: "add", args: [1n] }),
        authorizationList: [authorization],
      }),
    );
    assert.equal(
      (await this.#codeAt(account, receipt.blockNumber))?.toLowerCase(),
      delegationTo(contract),
      "the account does not delegate to LiveCheck",
    );
    assert.equal(
      await this.#countAt(account, receipt.blockNumber),
      countBefore + 1n,
      "the delegated add did not run",
    );
    this.#delegationBlock = receipt.blockNumber;
  }

  /**
   * `LiveCheck` rebuilds the `personal_sign` and EIP-712 digests and recovers the signer with
   * ecrecover. The calls ask for a block the contract exists at, so a lagging node cannot answer
   * from before it.
   */
  async signatures(): Promise<void> {
    const { wallet, account, publicClient } = this.#options;
    const contract = this.#need(this.#contract, "LiveCheck");
    const block = this.#need(this.#delegationBlock ?? this.#lastBlock, "a receipt");
    const message = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const personal = parseSignature(await wallet.signMessage({ message: { raw: message } }));
    assert.equal(
      await this.#at(
        async (blockNumber) =>
          await publicClient.readContract({
            address: contract,
            abi: LIVE_CHECK_ABI,
            functionName: "recoverPersonal",
            args: [message, Number(personal.v), personal.r, personal.s],
            blockNumber,
          }),
        block,
      ),
      account,
      "personal_sign does not recover to the KMS account on chain",
    );
    this.#check("personal_sign recovered by LiveCheck", block);
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
      await this.#at(
        async (blockNumber) =>
          await publicClient.readContract({
            address: contract,
            abi: LIVE_CHECK_ABI,
            functionName: "recoverCheck",
            args: [account, 3n, Number(typed.v), typed.r, typed.s],
            blockNumber,
          }),
        block,
      ),
      account,
      "eth_signTypedData_v4 does not recover to the KMS account on chain",
    );
    this.#check("eth_signTypedData_v4 recovered by LiveCheck", block);
  }

  #check(label: string, block: bigint): void {
    this.records.push({
      case: "signatures",
      label,
      type: null,
      hash: null,
      block: block.toString(),
      status: "success",
      from: "kms",
    });
  }

  /**
   * The KMS account sends 1 wei to the fresh address, carrying an authorization that a throwaway
   * key signed: the throwaway delegates to `LiveCheck`. A second transaction carries the
   * throwaway's authorization of the zero address, so no account stays delegated.
   */
  async sponsorOther(): Promise<void> {
    const { wallet } = this.#options;
    const contract = this.#need(this.#contract, "LiveCheck");
    const throwaway = this.#throwaway;
    // A fresh key: its nonce is 0, and the delegation it signs raises it to 1.
    const authorization = await throwaway.signAuthorization({
      chainId: SEPOLIA_CHAIN_ID,
      address: contract,
      nonce: 0,
    });
    this.#throwawayDelegated = true;
    const receipt = await this.mined(
      "sponsor-other",
      "1 wei to a fresh address, with a throwaway key's authorization",
      await wallet.sendTransaction({
        to: this.#recipient,
        value: 1n,
        authorizationList: [authorization],
      }),
    );
    await this.#checkRecipient(receipt.blockNumber);
    assert.equal(
      (await this.#codeAt(throwaway.address, receipt.blockNumber))?.toLowerCase(),
      delegationTo(contract),
      "the throwaway key does not delegate to LiveCheck",
    );
    await this.#clearThrowaway();
  }

  async #clearThrowaway(): Promise<void> {
    const { wallet, publicClient } = this.#options;
    const throwaway = this.#throwaway;
    const nonce = await this.#at(
      async (blockNumber) =>
        await publicClient.getTransactionCount({ address: throwaway.address, blockNumber }),
      this.#need(this.#lastBlock, "a receipt"),
    );
    const receipt = await this.mined(
      "sponsor-other",
      "clear the throwaway key's delegation",
      await wallet.sendTransaction({
        to: throwaway.address,
        authorizationList: [
          await throwaway.signAuthorization({
            chainId: SEPOLIA_CHAIN_ID,
            address: zeroAddress,
            nonce,
          }),
        ],
      }),
    );
    assert.ok(
      NO_CODE.includes(await this.#codeAt(throwaway.address, receipt.blockNumber)),
      "the throwaway key still has code",
    );
    this.#throwawayDelegated = false;
  }

  /**
   * Fork only: a local account, funded with `anvil_setBalance`, sends a transaction that carries
   * the KMS key's authorization to the 3-byte contract. The key signs with the account's current
   * nonce, since another account sends it.
   */
  async sponsoredByOther(): Promise<void> {
    const { rpc, account, forkUrl } = this.#options;
    assert.ok(forkUrl !== undefined, "a local sender runs only on the fork");
    const minimal = this.#need(this.#minimal, "the 3-byte contract");
    const sender = privateKeyToAccount(generatePrivateKey());
    await rpc.request({
      method: "anvil_setBalance",
      params: [sender.address, toHex(parseEther("1"))],
    });
    const authorization = await this.authorize(minimal, await this.nextNonce());
    const client = createWalletClient({
      account: sender,
      chain: FORK_CHAIN,
      transport: http(forkUrl),
    });
    this.delegated = true;
    const receipt = await this.mined(
      "sponsored-by-other",
      "a local account sends the KMS key's authorization",
      await client.sendTransaction({ to: this.#recipient, authorizationList: [authorization] }),
      sender.address,
    );
    assert.equal(
      (await this.#codeAt(account, receipt.blockNumber))?.toLowerCase(),
      delegationTo(minimal),
      "the account does not delegate to the 3-byte contract",
    );
  }

  /**
   * Fork only: delegates the account back to `LiveCheck` and calls an unknown selector on
   * itself, which reverts. EIP-7702 keeps the delegation anyway.
   */
  async revertSetCode(): Promise<void> {
    const { wallet, account } = this.#options;
    const contract = this.#need(this.#contract, "LiveCheck");
    const nonce = await this.nextNonce();
    const authorization = await this.authorize(contract, nonce + 1);
    this.delegated = true;
    const receipt = await this.mined(
      "revert-eip7702",
      "delegate back to LiveCheck and call an unknown selector",
      await wallet.sendTransaction({
        to: account,
        nonce,
        gas: 100_000n,
        data: UNKNOWN_SELECTOR,
        authorizationList: [authorization],
      }),
    );
    assert.equal(
      (await this.#codeAt(account, receipt.blockNumber))?.toLowerCase(),
      delegationTo(contract),
      "the reverted transaction's authorization was rolled back",
    );
  }

  /**
   * Clears the delegation with an authorization to the zero address, in a transaction that sends
   * 1 wei to the account itself, and checks the account has no code.
   */
  async clearDelegation(): Promise<void> {
    const { wallet, account } = this.#options;
    const nonce = await this.nextNonce();
    const receipt = await this.mined(
      "clear-delegation",
      "clear the delegation, with 1 wei to itself",
      await wallet.sendTransaction({
        to: account,
        nonce,
        value: 1n,
        authorizationList: [await this.authorize(zeroAddress, nonce + 1)],
      }),
    );
    assert.ok(
      NO_CODE.includes(await this.#codeAt(account, receipt.blockNumber)),
      "the account still has code after clearing its delegation",
    );
    this.delegated = false;
  }
}

/** The bytecode of `LiveCheck`, set by the suite once the fixture project is built. */
let liveCheckBytecode: Hex | undefined;

export function setLiveCheckBytecode(bytecode: unknown): void {
  assert.ok(isHex(bytecode) && bytecode.length > 2, "LiveCheck has no bytecode");
  liveCheckBytecode = bytecode;
}

/** The steps of each case. A case missing here fails the typecheck. */
const STEPS: Record<CaseId, (run: ProviderRun) => Promise<void>> = {
  "deploy-live-check": async (run) => {
    assert.ok(liveCheckBytecode !== undefined, "LiveCheck is not built");
    await run.deployLiveCheck(liveCheckBytecode);
  },
  "eth-to-eoa-legacy": async (run) => {
    await run.payRecipient("eth-to-eoa-legacy", "legacy");
  },
  "eth-to-eoa-eip2930": async (run) => {
    await run.payRecipient("eth-to-eoa-eip2930", "eip2930");
  },
  "eth-to-eoa-eip1559": async (run) => {
    await run.payRecipient("eth-to-eoa-eip1559", "eip1559");
  },
  "self-send-legacy": async (run) => {
    await run.selfSend("self-send-legacy", "legacy");
  },
  "self-send-eip2930": async (run) => {
    await run.selfSend("self-send-eip2930", "eip2930");
  },
  "self-send-eip1559": async (run) => {
    await run.selfSend("self-send-eip1559", "eip1559");
  },
  "deploy-minimal-legacy": async (run) => {
    await run.deployMinimal("deploy-minimal-legacy", "legacy");
  },
  "deploy-minimal-eip2930": async (run) => {
    await run.deployMinimal("deploy-minimal-eip2930", "eip2930");
  },
  "call-legacy": async (run) => {
    await run.callAdd("call-legacy", "legacy");
  },
  "call-eip2930": async (run) => {
    await run.callAdd("call-eip2930", "eip2930");
  },
  "call-eip1559": async (run) => {
    await run.callAdd("call-eip1559", "eip1559");
  },
  "revert-eip1559": async (run) => {
    await run.revert("revert-eip1559", "eip1559");
  },
  "revert-legacy": async (run) => {
    await run.revert("revert-legacy", "legacy");
  },
  "revert-eip2930": async (run) => {
    await run.revert("revert-eip2930", "eip2930");
  },
  "replace-legacy": async (run) => {
    await run.replace("replace-legacy", "legacy");
  },
  "replace-eip2930": async (run) => {
    await run.replace("replace-eip2930", "eip2930");
  },
  "replace-eip1559": async (run) => {
    await run.replace("replace-eip1559", "eip1559");
  },
  "delegate-and-call": async (run) => {
    await run.delegateAndCall();
  },
  signatures: async (run) => {
    await run.signatures();
  },
  "sponsor-other": async (run) => {
    await run.sponsorOther();
  },
  "sponsored-by-other": async (run) => {
    await run.sponsoredByOther();
  },
  "revert-eip7702": async (run) => {
    await run.revertSetCode();
  },
  "replace-eip7702": async (run) => {
    await run.replace("replace-eip7702", "eip7702");
  },
  "clear-delegation": async (run) => {
    await run.clearDelegation();
  },
};
