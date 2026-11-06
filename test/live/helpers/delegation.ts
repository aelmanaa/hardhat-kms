// Clears an EIP-7702 delegation that an earlier live run left on a test account, before a run sends
// anything from it (#685). A run clears its own delegations at the end, but a run that failed can
// leave one, and on Sepolia it then breaks the next run: a self-transfer would execute the
// delegate's code, and geth lets a delegated account have only one pending transaction.
import assert from "node:assert/strict";

import type { Address, Hash, Hex, SignedAuthorization } from "viem";

import { retryLagging } from "./retry.ts";

/** What a delegated account's code is: 0xef0100 followed by the delegate's address. */
const DELEGATION = /^0xef0100[0-9a-f]{40}$/i;

/** The gas of a transaction that carries one authorization and sends nothing: 31816 on Sepolia. */
const CLEAR_GAS = 60_000n;

/** The reads the cleanup makes; a viem public client has them. */
export interface DelegationReads {
  getCode(args: { address: Address; blockNumber?: bigint }): Promise<Hex | undefined>;
  getTransactionCount(args: { address: Address; blockTag: "pending" }): Promise<number>;
  waitForTransactionReceipt(args: {
    hash: Hash;
    timeout: number;
  }): Promise<{ status: "success" | "reverted"; blockNumber: bigint }>;
}

/** The transaction that clears the delegation. */
export interface ClearRequest {
  to: Address;
  nonce: number;
  gas: bigint;
  authorizationList: SignedAuthorization[];
}

/** What {@link clearLeftoverDelegation} needs. */
export interface ClearOptions {
  /** The KMS account. */
  account: Address;
  publicClient: DelegationReads;
  /** Signs the account's authorization of the zero address with the given nonce, on Sepolia. */
  authorize: (nonce: number) => Promise<SignedAuthorization>;
  /** Sends the request from the account and returns its hash. */
  send: (request: ClearRequest) => Promise<Hash>;
  /** How long to wait for the receipt. */
  timeoutMs: number;
}

/**
 * Clears the account's delegation, if it has one: a transaction to itself, with no value, carries
 * the account's authorization of the zero address. The authorization applies before the call, so
 * the call runs no delegate code. Fails on code that is not a delegation, which no run leaves.
 *
 * @param options - The account, the client and how to sign and send.
 * @returns The receipt's block, or undefined when the account had no code.
 */
export async function clearLeftoverDelegation(options: ClearOptions): Promise<bigint | undefined> {
  const { account, publicClient, authorize, send, timeoutMs } = options;
  const code = await publicClient.getCode({ address: account });
  if (code === undefined || code === "0x") {
    return undefined;
  }
  assert.ok(
    DELEGATION.test(code),
    `${account} has code (${code}) that is not an EIP-7702 delegation; no live run leaves that`,
  );
  // Nothing of the account's is pending once a run ends, so the pending count is the next nonce.
  // The authorization takes the nonce after the transaction's own: the sender is the authority.
  const nonce = await publicClient.getTransactionCount({ address: account, blockTag: "pending" });
  const hash = await send({
    to: account,
    nonce,
    gas: CLEAR_GAS,
    authorizationList: [await authorize(nonce + 1)],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: timeoutMs });
  assert.equal(receipt.status, "success", `clearing the leftover delegation reverted (${hash})`);
  const after = await retryLagging(
    async () => await publicClient.getCode({ address: account, blockNumber: receipt.blockNumber }),
  );
  assert.ok(
    after === undefined || after === "0x",
    `${account} still has code (${after}) after clearing its leftover delegation (${hash})`,
  );
  return receipt.blockNumber;
}
