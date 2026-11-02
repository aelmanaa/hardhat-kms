import { catalogError } from "hardhat-kms/provider-utils";
import { getAddress, hashTypedData, isAddress, isHex, type Address, type Hex } from "viem";

import { ERRORS } from "./error-catalog.ts";

/** The Safe versions the plugin proposes for. Older Safes have no `chainId` in their domain. */
export const SUPPORTED_VERSIONS = ["1.3.0", "1.4.1", "1.5.0"] as const;

/** A Safe version the plugin proposes for. */
export type SupportedVersion = (typeof SUPPORTED_VERSIONS)[number];

/** `0` is a call; `1` is a delegatecall, which runs the target's code in the Safe's storage. */
export type Operation = 0 | 1;

/** The fields of a `SafeTx`, as the Safe contract and the Transaction Service read them. */
export interface SafeTransaction {
  /** The call's target, checksummed. */
  to: Address;
  /** Wei the Safe sends with the call. */
  value: bigint;
  /** The call data, lowercase hex. */
  data: Hex;
  /** `0` for a call, `1` for a delegatecall. */
  operation: Operation;
  /** Always 0: the plugin proposes no gas refund. */
  safeTxGas: bigint;
  /** Always 0. */
  baseGas: bigint;
  /** Always 0: whoever executes pays the gas, and the Safe pays nobody back. */
  gasPrice: bigint;
  /** Always the zero address. */
  gasToken: Address;
  /** Always the zero address. */
  refundReceiver: Address;
  /** The Safe nonce the transaction takes. */
  nonce: bigint;
}

/** What to propose: one call from the Safe. The gas refund fields are always zero. */
export interface SafeCall {
  /** The target: a contract or an account. */
  to: string;
  /** Wei the Safe sends; 0 by default. */
  value?: bigint | undefined;
  /** The call data, `0x`-prefixed hex; `0x` by default. */
  data?: string | undefined;
  /** `1` for a delegatecall, which needs `allowDelegateCall`; `0` by default. */
  operation?: Operation | undefined;
}

/** The zero address. */
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** The largest nonce the plugin proposes: api-kit sends the nonce as a JSON number. */
export const MAX_NONCE: bigint = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * The EIP-712 `SafeTx` type, unchanged from Safe 1.0.0 to 1.5.0 (`SAFE_TX_TYPEHASH`
 * 0xbb8310d4…86d8 in each `Safe.sol`), with the domain of 1.3.0 and later: chain id and Safe.
 */
export const SAFE_TX_TYPES = {
  EIP712Domain: [
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/**
 * Reads an address the user gave: 40 hex characters after `0x`, with a valid EIP-55 checksum when
 * it is mixed case.
 *
 * @param value - The input.
 * @param field - What it is, for the error.
 * @returns The checksummed address.
 */
export function parseAddress(value: string, field: string): Address {
  if (!isAddress(value)) {
    throw catalogError(ERRORS.badAddress, { field });
  }
  return getAddress(value);
}

/**
 * The Safe version, when the plugin supports it.
 *
 * @param version - What the Safe's `VERSION()` returned.
 * @returns The version, or `undefined`.
 */
export function supportedVersion(version: string): SupportedVersion | undefined {
  return SUPPORTED_VERSIONS.find((supported) => supported === version);
}

/**
 * Builds the `SafeTx` for a call: value 0 and empty data unless given, and every gas refund field
 * zero, so whoever executes it is paid nothing from the Safe.
 *
 * @param call - The call.
 * @param nonce - The Safe nonce.
 * @returns The transaction.
 */
export function safeTransaction(call: SafeCall, nonce: bigint): SafeTransaction {
  const to = parseAddress(call.to, "to");
  const data = call.data ?? "0x";
  if (!isHex(data, { strict: true }) || data.length % 2 !== 0) {
    throw catalogError(ERRORS.badData, {});
  }
  const value = call.value ?? 0n;
  if (value < 0n) {
    throw catalogError(ERRORS.negative, { field: "value" });
  }
  if (nonce < 0n) {
    throw catalogError(ERRORS.negative, { field: "nonce" });
  }
  if (nonce > MAX_NONCE) {
    throw catalogError(ERRORS.nonceTooLarge, { nonce });
  }
  return {
    to,
    value,
    data: `0x${data.slice(2).toLowerCase()}`,
    operation: call.operation ?? 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce,
  };
}

/** The typed data of a `SafeTx`, with JSON-safe values for `eth_signTypedData_v4`. */
export interface SafeTxTypedData {
  types: typeof SAFE_TX_TYPES;
  primaryType: "SafeTx";
  domain: { chainId: string; verifyingContract: Address };
  message: {
    to: Address;
    value: string;
    data: Hex;
    operation: Operation;
    safeTxGas: string;
    baseGas: string;
    gasPrice: string;
    gasToken: Address;
    refundReceiver: Address;
    nonce: string;
  };
}

/**
 * The typed data a Safe owner signs, with uint256 fields as decimal strings, so it goes through
 * `eth_signTypedData_v4` and hardhat-kms's typed-data checks unchanged.
 *
 * @param chainId - The Safe's chain.
 * @param safe - The Safe.
 * @param tx - The transaction.
 * @returns The typed data.
 */
export function safeTxTypedData(
  chainId: bigint,
  safe: Address,
  tx: SafeTransaction,
): SafeTxTypedData {
  return {
    types: SAFE_TX_TYPES,
    primaryType: "SafeTx",
    domain: { chainId: chainId.toString(), verifyingContract: getAddress(safe) },
    message: {
      to: tx.to,
      value: tx.value.toString(),
      data: tx.data,
      operation: tx.operation,
      safeTxGas: tx.safeTxGas.toString(),
      baseGas: tx.baseGas.toString(),
      gasPrice: tx.gasPrice.toString(),
      gasToken: tx.gasToken,
      refundReceiver: tx.refundReceiver,
      nonce: tx.nonce.toString(),
    },
  };
}

/**
 * The SafeTx hash, computed with viem, apart from hardhat-kms's encoder, which builds the digest
 * the key signs.
 *
 * @param chainId - The Safe's chain.
 * @param safe - The Safe.
 * @param tx - The transaction.
 * @returns The hash the owners sign and the Safe's `getTransactionHash` returns.
 */
export function safeTxHash(chainId: bigint, safe: Address, tx: SafeTransaction): Hex {
  return hashTypedData({
    types: SAFE_TX_TYPES,
    primaryType: "SafeTx",
    domain: { chainId, verifyingContract: getAddress(safe) },
    message: tx,
  });
}
