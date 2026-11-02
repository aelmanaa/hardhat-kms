// Deploys Safe singletons, proxy factories and Safe proxies on a Hardhat connection, from the
// canonical creation bytecode in ../fixtures/safe-bytecode.json, whose runtime code hashes match
// @safe-global/safe-deployments 1.37.66 (test/integration/safe-bytecode.test.ts checks them).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  encodeFunctionData,
  getAddress,
  isHex,
  parseAbi,
  toEventSelector,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

export type SafeVersion = "1.3.0" | "1.4.1" | "1.5.0";
export const SAFE_VERSIONS: readonly SafeVersion[] = ["1.3.0", "1.4.1", "1.5.0"];

interface Bytecode {
  source: string;
  codeHash: Hex;
  safe: Hex;
  factory: Hex;
}

function hexField(value: unknown, name: string): Hex {
  const field: unknown =
    typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
  assert.ok(isHex(field), `safe-bytecode.json: ${name} is not hex`);
  return field;
}

/** The fixture, read with checks rather than a cast. */
export function bytecodeOf(version: SafeVersion): Bytecode {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL("../fixtures/safe-bytecode.json", import.meta.url), "utf8"),
  );
  const entry: unknown =
    typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, version) : undefined;
  const source: unknown =
    typeof entry === "object" && entry !== null ? Reflect.get(entry, "source") : undefined;
  assert.equal(typeof source, "string");
  return {
    source: String(source),
    codeHash: hexField(entry, "codeHash"),
    safe: hexField(entry, "safe"),
    factory: hexField(entry, "factory"),
  };
}

const FACTORY_ABI = parseAbi([
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
]);

const SAFE_TEST_ABI_ITEMS = [
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "function nonce() view returns (uint256)",
  "function addOwnerWithThreshold(address owner, uint256 _threshold)",
] as const;
export const SAFE_TEST_ABI: ReturnType<typeof parseAbi<typeof SAFE_TEST_ABI_ITEMS>> =
  parseAbi(SAFE_TEST_ABI_ITEMS);

const ZERO: Address = "0x0000000000000000000000000000000000000000";

/** Clients for a chain, sending from one of the node's own accounts. */
export interface Chain {
  publicClient: PublicClient;
  wallet: WalletClient;
  /** The node's account that deploys and pays. */
  deployer: Address;
  /** Other node accounts, as co-owners and recipients. */
  others: Address[];
}

async function deploy(chain: Chain, bytecode: Hex): Promise<Address> {
  const hash = await chain.wallet.deployContract({
    abi: [],
    bytecode,
    account: chain.deployer,
    chain: chain.wallet.chain,
  });
  const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
  assert.ok(receipt.contractAddress !== null && receipt.contractAddress !== undefined);
  return receipt.contractAddress;
}

/** A deployed singleton and factory of one version. */
export interface SafeSingleton {
  version: SafeVersion;
  singleton: Address;
  factory: Address;
}

export async function deploySingleton(chain: Chain, version: SafeVersion): Promise<SafeSingleton> {
  const code = bytecodeOf(version);
  return {
    version,
    singleton: await deploy(chain, code.safe),
    factory: await deploy(chain, code.factory),
  };
}

let salt = 0n;

/**
 * Creates a Safe proxy with these owners and threshold, and funds it with 1 ether.
 *
 * @returns The Safe's address.
 */
export async function createSafe(
  chain: Chain,
  singleton: SafeSingleton,
  owners: readonly Address[],
  threshold: bigint,
): Promise<Address> {
  const initializer = encodeFunctionData({
    abi: SAFE_TEST_ABI,
    functionName: "setup",
    args: [[...owners], threshold, ZERO, "0x", ZERO, ZERO, 0n, ZERO],
  });
  salt++;
  const { result, request } = await chain.publicClient.simulateContract({
    address: singleton.factory,
    abi: FACTORY_ABI,
    functionName: "createProxyWithNonce",
    args: [singleton.singleton, initializer, salt],
    account: chain.deployer,
  });
  const hash = await chain.wallet.writeContract({ ...request, account: chain.deployer });
  await chain.publicClient.waitForTransactionReceipt({ hash });
  const fund = await chain.wallet.sendTransaction({
    to: result,
    value: 10n ** 18n,
    account: chain.deployer,
    chain: chain.wallet.chain,
  });
  await chain.publicClient.waitForTransactionReceipt({ hash: fund });
  return getAddress(result);
}

/** A SafeTx to execute, as the proposal returns it. */
export interface Executable {
  safe: Address;
  safeTxHash: Hex;
  transaction: {
    to: Address;
    value: bigint;
    data: Hex;
    operation: 0 | 1;
    safeTxGas: bigint;
    baseGas: bigint;
    gasPrice: bigint;
    gasToken: Address;
    refundReceiver: Address;
  };
}

/**
 * Executes a SafeTx with packed signatures. The outer transaction can succeed while the inner call
 * fails, so this reports success only when the Safe emitted `ExecutionSuccess` for this hash.
 *
 * @returns Whether the Safe executed the transaction.
 */
export async function execute(
  chain: Chain,
  proposal: Executable,
  signatures: Hex,
): Promise<boolean> {
  const tx = proposal.transaction;
  const hash = await chain.wallet.writeContract({
    address: proposal.safe,
    abi: SAFE_TEST_ABI,
    functionName: "execTransaction",
    args: [
      tx.to,
      tx.value,
      tx.data,
      tx.operation,
      tx.safeTxGas,
      tx.baseGas,
      tx.gasPrice,
      tx.gasToken,
      tx.refundReceiver,
      signatures,
    ],
    account: chain.deployer,
    chain: chain.wallet.chain,
  });
  const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
  // ExecutionSuccess(bytes32,uint256): txHash is in the data in 1.3.0 and indexed from 1.4.0.
  const topic = toEventSelector("ExecutionSuccess(bytes32,uint256)");
  const executed = receipt.logs.some(
    (log) =>
      getAddress(log.address) === proposal.safe &&
      log.topics[0] === topic &&
      (log.topics[1] ?? log.data.slice(0, 66)) === proposal.safeTxHash,
  );
  return receipt.status === "success" && executed;
}
