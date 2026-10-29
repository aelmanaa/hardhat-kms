// Signs a KMS account's transaction the way Hardhat's LocalAccountsHandler#getSignedTransaction
// does: fill, build the unsigned transaction, sign its hash, and rebuild it with the signature
// (as micro-eth-signer's Transaction#signBy does). The signer computes the hash from the unsigned
// bytes and gives the adapter's `signTransaction`, when it has one, the bytes and the hash.
import { bytesToHexString, hexStringToBytes } from "@nomicfoundation/hardhat-utils/hex";
import { bytesToBigInt, bytesToNumber } from "@nomicfoundation/hardhat-utils/number";
import type { HardhatPluginError } from "hardhat/plugins";
import { Transaction } from "micro-eth-signer";

import { addressFromPublicKey, sameAddress, toChecksumAddress } from "../crypto/address.ts";
import { authorizationDigest } from "../crypto/digests.ts";
import { type RecoverableSignature, recoverPublicKey, toLowS } from "../crypto/signature.ts";
import { ERRORS } from "../error-catalog.ts";
import { catalogError } from "../errors.ts";
import { checkDelegate, type DelegateCheck } from "../signer/delegates.ts";
import {
  type KmsSigner,
  outstandingNonce,
  type ProviderCopy,
  providerCopyOf,
  type TransactionToSign,
} from "../signer/kms-signer.ts";
import { warn } from "../warnings.ts";
import {
  buildUnsignedTransaction,
  type FilledTransaction,
  type TransactionFiller,
  type UnsignedTransaction,
} from "./transaction-filler.ts";

/** The EIP-2718 type number of each of micro-eth-signer's transaction types. */
const TYPE_NUMBERS: Readonly<Record<UnsignedTransaction["type"], number>> = {
  legacy: 0,
  eip2930: 1,
  eip1559: 2,
  eip4844: 3,
  eip7702: 4,
};

/**
 * What the signer signs for an unsigned transaction: its unsigned serialized form, its type number,
 * its chain id and its nonce. The caller adds the signature to this same unsigned transaction with
 * {@link assembleSignedTransaction}.
 *
 * @param unsigned - The unsigned transaction.
 * @param chainId - Its chain id.
 * @returns The signer's request.
 */
export function transactionToSign(
  unsigned: UnsignedTransaction,
  chainId: bigint,
): TransactionToSign {
  return {
    unsigned: unsigned.toBytes(false),
    type: TYPE_NUMBERS[unsigned.type],
    chainId,
    nonce: unsigned.raw.nonce,
  };
}

/**
 * Adds a signature to an unsigned transaction, then checks that the signed transaction recovers
 * to the sender. The signer has already verified the signature against its key; this check
 * covers the step from signature to transaction.
 *
 * @param unsigned - The unsigned transaction.
 * @param signature - The verified signature of its signing hash.
 * @param from - The sender's address.
 * @param method - The RPC method, for error messages.
 * @returns The signed transaction.
 */
export function assembleSignedTransaction(
  unsigned: UnsignedTransaction,
  signature: RecoverableSignature,
  from: string,
  method: string,
): UnsignedTransaction {
  const { r, s, yParity } = signature;
  // Strict mode off, as in Transaction#signBy: strict mode is for user input.
  const signed = new Transaction(unsigned.type, { ...unsigned.raw, r, s, yParity }, false);
  const noRecovery = (): HardhatPluginError =>
    catalogError(ERRORS.txNoRecovery, { from: toChecksumAddress(from) }, { operation: method });
  let sender: string;
  try {
    sender = signed.recoverSender().address;
  } catch {
    throw noRecovery();
  }
  if (!sameAddress(sender, from)) {
    throw noRecovery();
  }
  return signed;
}

/**
 * Warns about pre-signed EIP-7702 authorizations that a node would skip: a high-S signature, or
 * one whose authority cannot be recovered. The transaction is still signed and sent, since a node
 * accepts it and only skips the authorization.
 *
 * @param tx - The filled transaction.
 */
function lintAuthorizations(tx: FilledTransaction): void {
  for (const [index, item] of (tx.authorizationList ?? []).entries()) {
    const r = bytesToBigInt(item.r);
    const s = bytesToBigInt(item.s);
    const yParity = bytesToNumber(item.yParity);
    const name = `authorizationList[${index}]`;
    if (toLowS(s) !== s) {
      warn(
        `${name} has a high-S signature, which EIP-7702 forbids; nodes skip this authorization. Sign it again with a low-S signer.`,
      );
    }
    const digest = authorizationDigest(item);
    const publicKey =
      yParity === 0 || yParity === 1 ? recoverPublicKey(digest, r, s, yParity) : undefined;
    if (publicKey === undefined) {
      warn(
        `${name}'s signature does not recover to an authority; nodes skip this authorization. Check its chainId, address, nonce and signature.`,
      );
    }
  }
}

/** An EIP-7702 authorization of a transaction that the sender signed. */
export interface SelfAuthorization {
  /** Its index in `authorizationList`. */
  index: number;
  /** The checksummed delegate. */
  delegate: string;
  chainId: bigint;
}

/**
 * Refuses self-authorizations invalidated by the final transaction nonce or chain.
 * The sender nonce advances before the list, then once for each valid self tuple.
 *
 * @param unsigned - The transaction with its final nonce.
 * @param from - The sender's address.
 * @param method - The operation for error messages.
 * @returns The self-authorizations, for {@link checkSelfDelegates}.
 */
export function checkSelfAuthorizations(
  unsigned: UnsignedTransaction,
  from: string,
  method: string,
): SelfAuthorization[] {
  const tx = unsigned.raw;
  if (!("authorizationList" in tx)) {
    return [];
  }
  const self: SelfAuthorization[] = [];
  let expected = tx.nonce + 1n;
  for (const [index, item] of tx.authorizationList.entries()) {
    const { r, s, yParity } = item;
    if (toLowS(s) !== s) {
      continue;
    }
    const digest = authorizationDigest({ ...item, address: hexStringToBytes(item.address) });
    const key =
      yParity === 0 || yParity === 1 ? recoverPublicKey(digest, r, s, yParity) : undefined;
    if (key === undefined || !sameAddress(addressFromPublicKey(key), from)) {
      continue;
    }
    if (item.chainId !== 0n && item.chainId !== tx.chainId) {
      throw catalogError(
        ERRORS.txSelfAuthorizationChain,
        { index, requested: item.chainId, chainId: tx.chainId },
        { operation: method },
      );
    }
    if (item.nonce !== expected) {
      throw catalogError(
        ERRORS.txSelfAuthorizationNonce,
        { index, nonce: item.nonce, expected },
        { operation: method },
      );
    }
    self.push({ index, delegate: toChecksumAddress(item.address), chainId: item.chainId });
    expected++;
  }
  return self;
}

/**
 * What {@link checkSelfDelegates} needs: the sender's key, the config keys a `--kms` key must not
 * copy, its node, and where notes go.
 */
export type TransactionDelegates = Pick<DelegateCheck, "key" | "commandLine" | "node" | "note">;

/**
 * Refuses a transaction whose self-authorization delegates the sender to a contract the key's
 * `allowedDelegates` does not allow on the authorization's chain (#562), before any KMS call.
 * Authorizations signed by other accounts are not checked.
 *
 * @param self - The transaction's self-authorizations, from {@link checkSelfAuthorizations}.
 * @param delegates - The sender's key and the node to read pinned delegates' code from.
 * @param method - The operation for error messages.
 */
export async function checkSelfDelegates(
  self: readonly SelfAuthorization[],
  delegates: TransactionDelegates,
  method: string,
): Promise<void> {
  for (const { index, delegate, chainId } of self) {
    await checkDelegate(
      {
        ...delegates,
        operation: method,
        refuse: (chain) =>
          catalogError(
            ERRORS.txSelfAuthorizationDelegate,
            { index, delegate, chain, keyName: delegates.key.name },
            { operation: method },
          ),
      },
      delegate,
      chainId,
    );
  }
}

/** What signing a transaction needs from the connection. */
export interface SignTransactionInputs {
  /** The connection's transaction filler. */
  filler: TransactionFiller;
  /** `eth_sendTransaction` or `eth_signTransaction`. */
  method: string;
  /** The request's params, with `from` set to the KMS account. */
  params: readonly unknown[];
  /** The KMS account's lowercase address. */
  from: string;
  /** The sender's key and node, to check the delegates of its self-authorizations. */
  delegates: TransactionDelegates;
  /**
   * Chooses the nonce from the filled one, when the caller gave none. Sends use it for the nonce
   * high-water mark and the reservations; without it, the filled nonce is signed.
   */
  chooseNonce?: ((filled: bigint) => bigint | Promise<bigint>) | undefined;
  /**
   * Checks the unsigned transaction before the KMS signs it, and throws to refuse it. The
   * `kms sign-tx` task checks a requested `type` with it.
   */
  checkUnsigned?: ((unsigned: UnsignedTransaction) => void) | undefined;
  /**
   * Keeps a nonce held when the provider may still sign the transaction after a timeout or an
   * abort (`core.signer.transaction-outstanding`); called before that error is thrown. Without it,
   * as for `kms sign-tx`, which sends nothing afterwards, no nonce is held and the error does not
   * describe a hold.
   */
  holdNonce?: ((nonce: bigint, copyHash?: string) => void) | undefined;
  /**
   * Runs right before the KMS is asked to sign, after the fill and the nonce choice, and throws to
   * refuse; sends check there that their connection is still open.
   */
  beforeSign?: (() => void) | undefined;
}

/** A signed transaction. */
export interface SignedTransaction {
  /** The signed raw transaction, as `0x` hex. */
  raw: string;
  /** Its hash, as `0x` hex. */
  hash: string;
  /** Its nonce. */
  nonce: bigint;
  /**
   * Set when the provider keeps a copy of the signed transaction (#537), whose nonce `holdNonce`
   * was then given: a broadcast that the node refuses leaves that copy valid later.
   */
  providerCopy?: ProviderCopy | undefined;
}

/**
 * Fills, signs and checks a KMS account's transaction. When the provider keeps a copy of the
 * signed transaction (`providerCopyOf`), the nonce goes to `holdNonce` right after the signature,
 * so it stays held until a transaction with it reaches the node.
 *
 * @param signer - The KMS account's signer.
 * @param inputs - The filler, the request and the sender.
 * @returns The signed transaction.
 */
export async function signTransaction(
  signer: KmsSigner,
  inputs: SignTransactionInputs,
): Promise<SignedTransaction> {
  let filled = await inputs.filler.fill(inputs.method, inputs.params);
  if (inputs.chooseNonce !== undefined) {
    filled = { ...filled, nonce: await inputs.chooseNonce(filled.nonce) };
  }
  if (!sameAddress(bytesToHexString(filled.from), inputs.from)) {
    throw catalogError(
      ERRORS.txNotFrom,
      { from: toChecksumAddress(inputs.from) },
      { operation: inputs.method },
    );
  }
  const unsigned = buildUnsignedTransaction(filled);
  inputs.checkUnsigned?.(unsigned);
  lintAuthorizations(filled);
  const self = checkSelfAuthorizations(unsigned, inputs.from, inputs.method);
  await checkSelfDelegates(self, inputs.delegates, inputs.method);
  inputs.beforeSign?.();
  let signature: RecoverableSignature;
  try {
    signature = await signer.signTransaction(transactionToSign(unsigned, filled.chainId), {
      holdsNonce: inputs.holdNonce !== undefined,
    });
  } catch (error) {
    const nonce = outstandingNonce(error);
    if (nonce !== undefined) {
      inputs.holdNonce?.(nonce);
    }
    throw error;
  }
  // Assembled first: a signature that does not recover to the sender makes no valid copy.
  const signed = assembleSignedTransaction(unsigned, signature, inputs.from, inputs.method);
  const hash = `0x${signed.hash}`;
  const providerCopy = providerCopyOf(signature);
  if (providerCopy !== undefined) {
    inputs.holdNonce?.(providerCopy.nonce, hash);
  }
  return { raw: signed.toHex(true), hash, nonce: filled.nonce, providerCopy };
}
