// Signs a KMS account's transaction the way Hardhat's LocalAccountsHandler#getSignedTransaction
// does: fill, build the unsigned transaction, sign its hash, and rebuild it with the signature
// (as micro-eth-signer's Transaction#signBy does).
import { bytesToHexString } from "@nomicfoundation/hardhat-utils/hex";
import { bytesToBigInt, bytesToNumber } from "@nomicfoundation/hardhat-utils/number";
import { Transaction } from "micro-eth-signer";

import { sameAddress, toChecksumAddress } from "../crypto/address.ts";
import { authorizationDigest } from "../crypto/digests.ts";
import { type RecoverableSignature, recoverPublicKey, toLowS } from "../crypto/signature.ts";
import { kmsError } from "../errors.ts";
import type { KmsSigner } from "../signer/kms-signer.ts";
import { warn } from "../warnings.ts";
import {
  buildUnsignedTransaction,
  type FilledTransaction,
  signingHash,
  type TransactionFiller,
  type UnsignedTransaction,
} from "./transaction-filler.ts";

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
  let sender: string | undefined;
  try {
    sender = signed.recoverSender().address;
  } catch {
    sender = undefined;
  }
  if (sender === undefined || !sameAddress(sender, from)) {
    throw kmsError(
      `the signed transaction does not recover to ${toChecksumAddress(from)}; nothing was sent`,
      { operation: method },
    );
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
  /**
   * Chooses the nonce from the filled one, when the caller gave none. Sends use it for the nonce
   * high-water mark; without it, the filled nonce is signed.
   */
  chooseNonce?: ((filled: bigint) => bigint) | undefined;
  /**
   * Checks the unsigned transaction before the KMS signs it, and throws to refuse it. The
   * `kms sign-tx` task checks a requested `type` with it.
   */
  checkUnsigned?: ((unsigned: UnsignedTransaction) => void) | undefined;
}

/** A signed transaction. */
export interface SignedTransaction {
  /** The signed raw transaction, as `0x` hex. */
  raw: string;
  /** Its hash, as `0x` hex. */
  hash: string;
  /** Its nonce. */
  nonce: bigint;
}

/**
 * Fills, signs and checks a KMS account's transaction.
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
    filled = { ...filled, nonce: inputs.chooseNonce(filled.nonce) };
  }
  if (!sameAddress(bytesToHexString(filled.from), inputs.from)) {
    throw kmsError(`the filled transaction is not from ${toChecksumAddress(inputs.from)}`, {
      operation: inputs.method,
    });
  }
  const unsigned = buildUnsignedTransaction(filled);
  inputs.checkUnsigned?.(unsigned);
  lintAuthorizations(filled);
  const signature = await signer.signDigest(signingHash(unsigned));
  const signed = assembleSignedTransaction(unsigned, signature, inputs.from, inputs.method);
  return { raw: signed.toHex(true), hash: `0x${signed.hash}`, nonce: filled.nonce };
}
