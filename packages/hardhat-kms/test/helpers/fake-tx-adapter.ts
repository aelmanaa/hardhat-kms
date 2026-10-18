// A fake adapter with `signTransaction`, as a provider whose service parses transactions (Turnkey's
// `sign_transaction`) would implement it, and the hostile behaviours the core must refuse.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { Transaction } from "micro-eth-signer";

import type { SignatureOutput } from "../../src/internal/crypto/signature.ts";
import type { KmsKeyAdapter, SignContext } from "../../src/internal/signer/types.ts";
import { fakeAdapter } from "./fake-adapter.ts";

const CURVE_ORDER = secp256k1.Point.CURVE().n;

/**
 * What a hostile `signTransaction` does instead of signing the transaction it received.
 *
 * - `otherBody`: signs the same transaction with `value` raised by one, as a service that signed
 *   something other than what it was asked to would.
 * - `otherKey`: signs the right hash with another key.
 * - `highS`: returns the high-S twin of the right signature, which the core normalizes.
 * - `malformed`: returns `r = 0`, which is out of range.
 * - `digestOnly`: signs the `digest` it received without looking at `unsigned`.
 * - `overwrite`: overwrites the arrays it received, then signs the overwritten `unsigned`.
 * - `scribble`: signs the right hash, then overwrites the arrays it received.
 */
export type TxBehaviour =
  | "honest"
  | "otherBody"
  | "otherKey"
  | "highS"
  | "malformed"
  | "digestOnly"
  | "overwrite"
  | "scribble";

/** How a fake transaction adapter behaves. */
export interface FakeTxAdapterOptions {
  /** The key the adapter signs with. */
  secretKey: Uint8Array;
  /** The key `otherKey` signs with. */
  otherSecretKey?: Uint8Array;
  /** What `signTransaction` does. */
  behaviour?: TxBehaviour;
  /** Behave as `behaviour` only for the first N `signTransaction` calls, then honestly. */
  behaviourForCalls?: number;
  /** Expose `getPublicKey` (default) or only `getAddress`/nothing. */
  identity?: "publicKey" | "address" | "none";
}

/** One `signTransaction` request, as the adapter received it, copied before any change. */
export interface ReceivedTransaction {
  unsigned: Uint8Array;
  digest: Uint8Array;
  type: number;
  chainId: bigint;
}

/** A fake adapter with `signTransaction`, plus what it was asked. */
export interface FakeTxAdapter extends KmsKeyAdapter {
  calls: {
    signDigest: number;
    signMessage: number;
    signTransaction: number;
  };
  /** Every `signTransaction` request, in order. */
  transactions: ReceivedTransaction[];
}

/**
 * Signs a 32-byte hash, low-S, as `{ r, s }`.
 *
 * @param hash - The hash.
 * @param secretKey - The key.
 * @returns The signature.
 */
function signHash(hash: Uint8Array, secretKey: Uint8Array): { r: bigint; s: bigint } {
  const compact = secp256k1.sign(hash, secretKey, { prehash: false, lowS: true });
  const { r, s } = secp256k1.Signature.fromBytes(compact, "compact");
  return { r, s };
}

/**
 * The same unsigned transaction with `value` raised by one.
 *
 * @param unsigned - An unsigned serialized transaction.
 * @returns Another unsigned serialized transaction.
 */
export function otherBody(unsigned: Uint8Array): Uint8Array {
  const tx = Transaction.fromHex(Buffer.from(unsigned).toString("hex"), false);
  return new Transaction(tx.type, { ...tx.raw, value: tx.raw.value + 1n }, false).toBytes(false);
}

/**
 * Builds an adapter that signs transactions by hashing the unsigned bytes it receives, as a
 * service that parses the transaction does, and digests, messages and typed data through the
 * plain fake adapter.
 *
 * @param options - The key and the behaviour.
 * @returns The adapter.
 */
export function fakeTxAdapter(options: FakeTxAdapterOptions): FakeTxAdapter {
  const inner = fakeAdapter({
    secretKey: options.secretKey,
    ...(options.identity === undefined ? {} : { identity: options.identity }),
  });
  const calls = { signDigest: 0, signMessage: 0, signTransaction: 0 };
  const transactions: ReceivedTransaction[] = [];
  const otherKey = options.otherSecretKey ?? secp256k1.utils.randomSecretKey();

  const behaviourFor = (call: number): TxBehaviour => {
    const limit = options.behaviourForCalls;
    return limit !== undefined && call > limit ? "honest" : (options.behaviour ?? "honest");
  };

  const signTransaction = async (
    request: { unsigned: Uint8Array; digest: Uint8Array; type: number; chainId: bigint },
    ctx: SignContext,
  ): Promise<SignatureOutput> => {
    calls.signTransaction++;
    transactions.push({
      unsigned: new Uint8Array(request.unsigned),
      digest: new Uint8Array(request.digest),
      type: request.type,
      chainId: request.chainId,
    });
    if (ctx.signal.aborted) {
      throw new Error("aborted");
    }
    const { unsigned, digest } = request;
    switch (behaviourFor(calls.signTransaction)) {
      case "honest":
        return signHash(keccak_256(unsigned), options.secretKey);
      case "otherBody":
        return signHash(keccak_256(otherBody(unsigned)), options.secretKey);
      case "otherKey":
        return signHash(keccak_256(unsigned), otherKey);
      case "highS": {
        const { r, s } = signHash(keccak_256(unsigned), options.secretKey);
        return { r, s: CURVE_ORDER - s };
      }
      case "malformed":
        return { r: 0n, s: 1n };
      case "digestOnly":
        return signHash(digest, options.secretKey);
      case "overwrite":
        unsigned.fill(7);
        digest.fill(7);
        return signHash(keccak_256(unsigned), options.secretKey);
      case "scribble": {
        const signature = signHash(keccak_256(unsigned), options.secretKey);
        unsigned.fill(7);
        digest.fill(7);
        return signature;
      }
    }
    throw new Error("unknown behaviour");
  };

  const adapter: FakeTxAdapter = {
    calls,
    transactions,
    describe: () => inner.describe(),
    signDigest: async (request, ctx) => {
      calls.signDigest++;
      return await (inner.signDigest?.(request, ctx) ?? Promise.reject(new Error("missing")));
    },
    signMessage: async ({ digest }, ctx) => {
      calls.signMessage++;
      return await (inner.signDigest?.({ digest }, ctx) ?? Promise.reject(new Error("missing")));
    },
    signTransaction,
  };
  if (inner.getPublicKey !== undefined) {
    adapter.getPublicKey = inner.getPublicKey.bind(inner);
  }
  if (inner.getAddress !== undefined) {
    adapter.getAddress = inner.getAddress.bind(inner);
  }
  return adapter;
}
