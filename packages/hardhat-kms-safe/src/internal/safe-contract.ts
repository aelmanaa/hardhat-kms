import { catalogError } from "hardhat-kms/provider-utils";
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isHex,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

import { ERRORS } from "./error-catalog.ts";
import { supportedVersion, type SafeTransaction, type SupportedVersion } from "./safe-tx.ts";

/** The part of an EIP-1193 provider the proposer uses, such as a Hardhat connection's `provider`. */
export interface Eip1193Provider {
  /** Sends a JSON-RPC request. */
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/**
 * The Safe functions the proposer reads. Each has the same signature in 1.3.0, 1.4.1 and 1.5.0;
 * `checkNSignatures(bytes32,bytes,bytes,uint256)` is a legacy overload in 1.5.0.
 */
const SAFE_ABI = parseAbi([
  "function VERSION() view returns (string)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function checkNSignatures(bytes32 dataHash, bytes data, bytes signatures, uint256 requiredSignatures) view",
]);

/** What the proposer reads from the Safe before the key signs. */
export interface SafeState {
  /** `VERSION()`, one the plugin supports. */
  version: SupportedVersion;
  /** `getOwners()`, checksummed. */
  owners: Address[];
  /** `getThreshold()`. */
  threshold: bigint;
  /** `nonce()`: the nonce of the next transaction the Safe executes. */
  nonce: bigint;
}

/**
 * Runs `eth_call` at `latest`.
 *
 * @param provider - The connection.
 * @param to - The contract.
 * @param data - The call data.
 * @returns The returned data, or `undefined` when the call fails or the node answers something
 *   other than hex.
 */
async function call(provider: Eip1193Provider, to: Address, data: Hex): Promise<Hex | undefined> {
  try {
    const result = await provider.request({ method: "eth_call", params: [{ to, data }, "latest"] });
    return isHex(result) ? result : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the Safe's code, version, owners, threshold and nonce at `latest`. Refuses an address
 * without code and a version the plugin does not support, before it reads the rest.
 *
 * @param provider - The connection.
 * @param safe - The Safe.
 * @param chainId - The connection's chain, for the errors.
 * @returns What the Safe says now.
 */
export async function readSafe(
  provider: Eip1193Provider,
  safe: Address,
  chainId: bigint,
): Promise<SafeState> {
  const code = await provider.request({ method: "eth_getCode", params: [safe, "latest"] });
  if (!isHex(code) || /^0x0*$/.test(code)) {
    throw catalogError(ERRORS.noCode, { safe, chainId });
  }
  const unreadable = (name: string): Error =>
    catalogError(ERRORS.unreadable, { safe, function: `${name}()` });
  const read = async (
    functionName: "VERSION" | "getOwners" | "getThreshold" | "nonce",
  ): Promise<Hex> => {
    const data = await call(provider, safe, encodeFunctionData({ abi: SAFE_ABI, functionName }));
    if (data === undefined) {
      throw unreadable(functionName);
    }
    return data;
  };
  const decoded = <T>(name: string, decode: () => T): T => {
    try {
      return decode();
    } catch {
      throw unreadable(name);
    }
  };
  const versionData = await read("VERSION");
  const version = decoded("VERSION", () =>
    decodeFunctionResult({ abi: SAFE_ABI, functionName: "VERSION", data: versionData }),
  );
  const supported = supportedVersion(version);
  if (supported === undefined) {
    throw catalogError(ERRORS.unsupportedVersion, { safe, version: printableVersion(version) });
  }
  const ownersData = await read("getOwners");
  const owners = decoded("getOwners", () =>
    decodeFunctionResult({ abi: SAFE_ABI, functionName: "getOwners", data: ownersData }),
  );
  const thresholdData = await read("getThreshold");
  const threshold = decoded("getThreshold", () =>
    decodeFunctionResult({ abi: SAFE_ABI, functionName: "getThreshold", data: thresholdData }),
  );
  const nonceData = await read("nonce");
  const nonce = decoded("nonce", () =>
    decodeFunctionResult({ abi: SAFE_ABI, functionName: "nonce", data: nonceData }),
  );
  return {
    version: supported,
    owners: owners.map((owner) => getAddress(owner)),
    threshold,
    nonce,
  };
}

/**
 * Asks the Safe for the hash of `tx`, so the key signs the hash the contract checks.
 *
 * @param provider - The connection.
 * @param safe - The Safe.
 * @param tx - The transaction.
 * @returns The Safe's `getTransactionHash`.
 */
export async function contractSafeTxHash(
  provider: Eip1193Provider,
  safe: Address,
  tx: SafeTransaction,
): Promise<Hex> {
  const data = await call(
    provider,
    safe,
    encodeFunctionData({
      abi: SAFE_ABI,
      functionName: "getTransactionHash",
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
        tx.nonce,
      ],
    }),
  );
  if (data !== undefined) {
    try {
      return decodeFunctionResult({ abi: SAFE_ABI, functionName: "getTransactionHash", data });
    } catch {
      // Reported below, as for no answer.
    }
  }
  throw catalogError(ERRORS.unreadable, { safe, function: "getTransactionHash()" });
}

/**
 * Runs the Safe's own `checkNSignatures(hash, 0x, signature, 1)` with `eth_call`: it passes only
 * when the signature recovers to a current owner, by the code the Safe runs when it executes.
 * `data` is read only for contract signatures, so `0x` is enough for an owner's ECDSA signature.
 *
 * @param provider - The connection.
 * @param safe - The Safe.
 * @param hash - The SafeTx hash.
 * @param signature - The owner's 65-byte signature.
 * @returns `accepted`, `refused` when the call reverted, or `failed` when the node could not run
 *   it.
 */
export async function safeAcceptsSignature(
  provider: Eip1193Provider,
  safe: Address,
  hash: Hex,
  signature: Hex,
): Promise<"accepted" | "refused" | "failed"> {
  const data = encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "checkNSignatures",
    args: [hash, "0x", signature, 1n],
  });
  try {
    const result = await provider.request({
      method: "eth_call",
      params: [{ to: safe, data }, "latest"],
    });
    return isHex(result) ? "accepted" : "failed";
  } catch (error) {
    return isRevert(error) ? "refused" : "failed";
  }
}

/**
 * Whether an `eth_call` failed because the contract reverted, rather than because the node could
 * not run it: a JSON-RPC error with code 3, revert data, or a message that says it reverted.
 *
 * @param error - What the provider threw.
 * @returns Whether it is a revert.
 */
function isRevert(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code: unknown = Reflect.get(error, "code");
  const data: unknown = Reflect.get(error, "data");
  const message: unknown = Reflect.get(error, "message");
  return (
    code === 3 ||
    (typeof data === "string" && isHex(data)) ||
    (typeof message === "string" && /revert/i.test(message))
  );
}

/**
 * A Safe's `VERSION()` as an error shows it: quoted, printable characters only, at most 20.
 *
 * @param version - What the contract returned.
 * @returns The text to show.
 */
function printableVersion(version: string): string {
  return JSON.stringify(version.replace(/[^\x20-\x7e]/g, "?").slice(0, 20));
}
