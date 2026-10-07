import { secp256k1 } from "@noble/curves/secp256k1.js";
import { addr as microAddr } from "micro-eth-signer";

import type { SignatureOutput } from "../../src/internal/crypto/signature.ts";
import type { KmsKeyAdapter, SignContext } from "../../src/internal/signer/types.ts";

const CURVE_ORDER = secp256k1.Point.CURVE().n;

/** How a fake adapter behaves. */
export interface FakeAdapterOptions {
  /** The key the adapter signs with. */
  secretKey: Uint8Array;
  /** Wire format of the signatures, like AWS/GCP (`der`), Azure (`compact`) or API signers (`rs`). */
  format?: "der" | "compact" | "rs";
  /** Return the high-S twin of every signature, as AWS KMS and Azure may do. */
  highS?: boolean;
  /** Sign with this key instead, to simulate a backend returning a signature from the wrong key. */
  signWithSecretKey?: Uint8Array;
  /** Sign with the wrong key only for the first N calls. */
  wrongKeyForCalls?: number;
  /** Expose `getPublicKey` (default) or only `getAddress`/nothing. */
  identity?: "publicKey" | "address" | "none";
  /** Never answer, until the signal aborts. */
  hang?: boolean;
  /** Throw this from every call. */
  throwError?: Error;
  /** Awaited before each signature, so a test can hold or slow down signing. */
  beforeSign?: () => Promise<void>;
  /**
   * Add fresh randomness to each signature, so that signing one digest twice gives two different
   * signatures, as a KMS that picks a random `k` does.
   */
  randomK?: boolean;
}

/** A fake adapter plus counters for assertions. */
export interface FakeAdapter extends KmsKeyAdapter {
  calls: { getPublicKey: number; getAddress: number; signDigest: number };
}

/**
 * Builds an adapter that signs with a local key and returns real provider wire formats.
 * Signatures are deterministic (RFC 6979), like Hardhat's own local accounts, unless `randomK` is set.
 */
export function fakeAdapter(options: FakeAdapterOptions): FakeAdapter {
  const calls = { getPublicKey: 0, getAddress: 0, signDigest: 0 };
  const publicKey = secp256k1.getPublicKey(options.secretKey, false);
  const address = addressOf(publicKey);

  const guard = async (ctx: SignContext): Promise<void> => {
    if (options.throwError !== undefined) {
      throw options.throwError;
    }
    if (options.hang === true) {
      await new Promise((_, reject) => {
        ctx.signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    }
  };

  const adapter: FakeAdapter = {
    calls,
    describe: () => ({ provider: "fake", pinnedId: "fake-key-1", displayId: "fake-key-1" }),
    async signDigest({ digest }, ctx): Promise<SignatureOutput> {
      calls.signDigest++;
      await guard(ctx);
      await options.beforeSign?.();
      const wrong =
        options.signWithSecretKey !== undefined ||
        (options.wrongKeyForCalls !== undefined && calls.signDigest <= options.wrongKeyForCalls);
      const key = wrong
        ? (options.signWithSecretKey ?? secp256k1.utils.randomSecretKey())
        : options.secretKey;
      const compact = secp256k1.sign(digest, key, {
        prehash: false,
        lowS: true,
        format: "compact",
        extraEntropy: options.randomK === true,
      });
      let { r, s } = secp256k1.Signature.fromBytes(compact, "compact");
      if (options.highS === true) {
        s = CURVE_ORDER - s;
      }
      const signature = new secp256k1.Signature(r, s);
      switch (options.format ?? "der") {
        case "der":
          return { format: "der", bytes: signature.toBytes("der") };
        case "compact":
          return { format: "compact", bytes: signature.toBytes("compact") };
        case "rs":
          return { r, s };
      }
      throw new Error(`unknown format ${String(options.format)}`);
    },
  };

  const identity = options.identity ?? "publicKey";
  if (identity === "publicKey") {
    adapter.getPublicKey = async (ctx) => {
      calls.getPublicKey++;
      await guard(ctx);
      return publicKey;
    };
  } else if (identity === "address") {
    adapter.getAddress = async (ctx) => {
      calls.getAddress++;
      await guard(ctx);
      return address;
    };
  }
  return adapter;
}

/**
 * Checksummed address of a secret key, computed independently of the code under test.
 *
 * @param secretKey - The secret key.
 * @returns The address.
 */
export function addressOfSecretKey(secretKey: Uint8Array): string {
  return addressOf(secp256k1.getPublicKey(secretKey, false));
}

function addressOf(publicKey: Uint8Array): string {
  // micro-eth-signer's addr is the reference implementation Hardhat uses.
  return microAddr.fromPublicKey(publicKey);
}
