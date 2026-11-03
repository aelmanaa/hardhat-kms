import { catalogError } from "hardhat-kms/provider-utils";
import {
  getAddress,
  hexToBigInt,
  isAddress,
  isHex,
  recoverAddress,
  type Address,
  type Hex,
} from "viem";

import { safeAppLink } from "./chains.ts";
import { ERRORS } from "./error-catalog.ts";
import {
  contractSafeTxHash,
  readSafe,
  safeAcceptsSignature,
  type Eip1193Provider,
} from "./safe-contract.ts";
import {
  parseAddress,
  safeTransaction,
  safeTxHash,
  safeTxTypedData,
  type SafeCall,
  type SafeTransaction,
  type SupportedVersion,
} from "./safe-tx.ts";
import { proposalBody, type TransactionServiceClient } from "./tx-service.ts";

/**
 * How far above the Safe's on-chain nonce the default nonce may go, from the service's queue. A
 * caller who passes `nonce` is not bounded.
 */
const MAX_QUEUE_AHEAD = 50n;

/** What the key is about to sign, after every check before signing passed. */
export interface SafeTransactionReview {
  /** The connection's chain. */
  chainId: bigint;
  /** The Safe, checksummed. */
  safe: Address;
  /** The Safe's `VERSION()`. */
  version: SupportedVersion;
  /** The Safe's owners at the latest block. */
  owners: Address[];
  /** The Safe's threshold at the latest block. */
  threshold: bigint;
  /** The Safe's on-chain nonce: the next transaction it executes. */
  safeNonce: bigint;
  /** The owner that signs. */
  sender: Address;
  /** The transaction. */
  transaction: SafeTransaction;
  /** Its SafeTx hash, which the Safe's `getTransactionHash` returned too. */
  safeTxHash: Hex;
}

/** A proposal the service stored. */
export interface SafeProposal extends SafeTransactionReview {
  /** The owner's 65-byte signature, with v 27 or 28. */
  signature: Hex;
  /** The Safe app's page for the transaction, for a chain Safe's hosted service serves. */
  link: string | undefined;
}

/** What to propose, and where. */
export interface ProposeSafeTransactionOptions {
  /**
   * A connection that signs for `sender` with `eth_signTypedData_v4`, such as a Hardhat network
   * connection's `provider`.
   */
  provider: Eip1193Provider;
  /**
   * The owner that signs: an address the connection signs for, such as a KMS account, a key in
   * the network's `accounts` or a Ledger address in its `ledgerAccounts`. The function sends the
   * signing request for this address to `provider` as it is: on a Hardhat `http` network whose
   * `accounts` is `"remote"`, Hardhat forwards a request for an address it does not hold to the
   * node, which signs with its own key. The `kms safe propose` task refuses that; this function
   * cannot tell, so pass only an address the connection signs for in this process.
   */
  sender: string;
  /** The Safe. */
  safe: string;
  /** The call the Safe makes. */
  call: SafeCall;
  /** The Transaction Service to propose to. */
  service: TransactionServiceClient;
  /**
   * The Safe nonce. By default the next one: one above the highest queued transaction, or the
   * Safe's nonce when nothing is queued. A nonce below the Safe's nonce is refused.
   */
  nonce?: bigint | undefined;
  /** Allow `operation: 1`, a delegatecall: the Safe runs the target's code with its own storage. */
  allowDelegateCall?: boolean | undefined;
  /** The chain the connection must be on, such as the network's configured `chainId`. */
  expectedChainId?: bigint | undefined;
  /** A label the Safe app shows next to the transaction. */
  origin?: string | undefined;
  /**
   * Called after every check and before the key signs. Return `false` to stop: nothing is signed
   * and the call fails with `safe.task.declined`. The `kms safe propose` task asks a person here
   * when the threshold is 1.
   */
  approve?: ((review: SafeTransactionReview) => Promise<boolean>) | undefined;
  /** Stops the requests to the service. */
  signal?: AbortSignal | undefined;
}

/**
 * Proposes a Safe transaction signed by `sender`, an account the connection signs for, such as a
 * KMS key, a key in the network's `accounts` or a Ledger. It reads the Safe on the connection's
 * chain and refuses, before anything is signed: a Safe with no code, a version other than 1.3.0,
 * 1.4.1 or 1.5.0, a sender that is not an owner, a nonce below the Safe's, a delegatecall without
 * `allowDelegateCall`, and a hash that differs from the Safe's own `getTransactionHash`. The
 * sender signs the SafeTx as EIP-712 typed data through the connection's `eth_signTypedData_v4`;
 * for a KMS account, hardhat-kms also checks the typed data's chain and verifies the signature.
 * The signature must then have v 27 or 28, recover to the sender and pass the Safe's
 * `checkNSignatures`. Only then is it posted to the service. Gas refund fields are always zero.
 *
 * This function does not ask anyone before it signs. A Safe whose threshold is 1 can execute the
 * transaction with this signature alone; pass `approve` to decide.
 *
 * @param options - What to propose, and where.
 * @returns The proposal the service stored.
 * @throws A `HardhatPluginError` built from the package's error catalogue for each refusal.
 */
export async function proposeSafeTransaction(
  options: ProposeSafeTransactionOptions,
): Promise<SafeProposal> {
  const { provider, service } = options;
  if (!isAddress(options.sender)) {
    throw catalogError(ERRORS.badSender, {});
  }
  const sender = getAddress(options.sender);
  const safe = parseAddress(options.safe, "safe");
  const to = parseAddress(options.call.to, "to");
  // Builds the transaction once with a placeholder nonce, so every field of the call is checked,
  // its operation included, before the delegatecall gate and before anything is read.
  const { operation } = safeTransaction(options.call, 0n);
  if (operation === 1 && options.allowDelegateCall !== true) {
    throw catalogError(ERRORS.delegatecall, { to });
  }

  const chainIdAnswer = await provider.request({ method: "eth_chainId" });
  if (!isHex(chainIdAnswer, { strict: true }) || chainIdAnswer === "0x") {
    throw catalogError(ERRORS.chainUnreadable, {});
  }
  const chainId = hexToBigInt(chainIdAnswer);
  if (options.expectedChainId !== undefined && options.expectedChainId !== chainId) {
    throw catalogError(ERRORS.chainMismatch, {
      actual: chainId,
      expected: options.expectedChainId,
    });
  }

  const state = await readSafe(provider, safe, chainId);
  const { version } = state;
  if (!state.owners.includes(sender)) {
    throw catalogError(ERRORS.notOwner, {
      sender,
      safe,
      chainId,
      owners: state.owners.join(", "),
    });
  }

  let nonce = options.nonce;
  if (nonce === undefined) {
    const queued = await service.highestQueuedNonce(safe, state.nonce, options.signal);
    nonce = queued !== undefined && queued + 1n > state.nonce ? queued + 1n : state.nonce;
    // The service is trusted to raise the nonce, by a bounded amount only.
    if (nonce - state.nonce > MAX_QUEUE_AHEAD) {
      throw catalogError(ERRORS.nonceAhead, {
        nonce,
        ahead: nonce - state.nonce,
        safeNonce: state.nonce,
      });
    }
  } else if (nonce < state.nonce) {
    throw catalogError(ERRORS.nonceUsed, { nonce, safeNonce: state.nonce });
  }

  const transaction = safeTransaction(options.call, nonce);
  const hash = safeTxHash(chainId, safe, transaction);
  const contractHash = await contractSafeTxHash(provider, safe, transaction);
  if (contractHash.toLowerCase() !== hash.toLowerCase()) {
    throw catalogError(ERRORS.hashMismatch, { contractHash, hash });
  }

  const review: SafeTransactionReview = {
    chainId,
    safe,
    version,
    owners: state.owners,
    threshold: state.threshold,
    safeNonce: state.nonce,
    sender,
    transaction,
    safeTxHash: hash,
  };
  if (options.approve !== undefined && !(await options.approve(review))) {
    throw catalogError(ERRORS.declined, {});
  }

  // The owner signs here, through the connection: hardhat-kms for a KMS account, Hardhat for a key
  // in the network's accounts, hardhat-ledger for a Ledger. The domain names this chain.
  const signature = await provider.request({
    method: "eth_signTypedData_v4",
    params: [sender, JSON.stringify(safeTxTypedData(chainId, safe, transaction))],
  });
  if (!isHex(signature, { strict: true }) || signature.length !== 132) {
    throw catalogError(ERRORS.signatureShape, {});
  }
  const v = Number.parseInt(signature.slice(130), 16);
  if (v !== 27 && v !== 28) {
    throw catalogError(ERRORS.signatureShape, {});
  }
  let recovered: Address;
  try {
    recovered = await recoverAddress({ hash, signature });
  } catch {
    throw catalogError(ERRORS.signatureSigner, { recovered: "no address", sender });
  }
  if (recovered !== sender) {
    throw catalogError(ERRORS.signatureSigner, { recovered, sender });
  }
  const check = await safeAcceptsSignature(provider, safe, hash, signature);
  if (check === "failed") {
    throw catalogError(ERRORS.checkFailed, {});
  }
  if (check === "refused") {
    throw catalogError(ERRORS.signatureRefused, {});
  }

  await service.propose(
    safe,
    proposalBody(transaction, hash, sender, signature, options.origin),
    options.signal,
  );
  return { ...review, signature, link: safeAppLink(chainId, safe, hash) };
}
