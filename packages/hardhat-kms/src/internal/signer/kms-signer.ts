import { randomUUID } from "node:crypto";

import { keccak_256 } from "@noble/hashes/sha3.js";
import { HardhatPluginError } from "hardhat/plugins";

import {
  addressFromPublicKey,
  InvalidAddressError,
  sameAddress,
  toChecksumAddress,
} from "../crypto/address.ts";
import {
  personalMessageDigest,
  type TypedData,
  typedDataDigest,
  verifyPersonalMessageSignature,
  verifyTypedDataSignature,
} from "../crypto/digests.ts";
import { assertOnCurve, InvalidPublicKeyError } from "../crypto/public-key.ts";
import {
  InvalidSignatureError,
  normalizeSignature,
  parseSignature,
  type RecoverableSignature,
  recoverPublicKey,
  type SignatureOutput,
  toLowS,
  toRpcSignature,
} from "../crypto/signature.ts";
import { coreDebug } from "../debug.ts";
import { ERRORS } from "../error-catalog.ts";
import {
  catalogError,
  catalogMessage,
  type ErrorEntry,
  errorName,
  type TemplateParams,
} from "../errors.ts";
import {
  CancelledError,
  systemTimers,
  TimeoutError,
  type Timers,
  untilCancelled,
  withTimeout,
} from "./timeout.ts";
import type { KeyDescription, KmsKeyAdapter, SignContext } from "./types.ts";

const log = coreDebug("signer");

/** Options for a {@link KmsSigner}. */
export interface KmsSignerOptions {
  /** The address the key must derive to. Checked before the first signature is released. */
  expectedAddress?: string | undefined;
  /** Time budget for each provider call, in milliseconds: an integer from 1 to 2^31 - 1. */
  timeoutMs: number;
  /** Shows a status line to the user. */
  displayMessage(message: string): Promise<void>;
  /**
   * How to show the key in errors and logs, normally the resolved config's `displayId`. Taken
   * from the configuration rather than from the adapter, which may be third-party code.
   */
  displayId?: string | undefined;
  /** Timer functions, for tests. */
  timers?: Timers | undefined;
}

/**
 * Options of one signer call. The signer is shared by every connection of a Hardhat runtime, so a
 * caller's signal belongs to the call, not to the signer.
 */
export interface SignerCallOptions {
  /**
   * The caller's signal. When it aborts, the provider call's own signal aborts too, and the call
   * rejects with `core.signer.cancelled` and is not retried. A key lookup that other callers share
   * goes on, bounded by the key's `timeoutMs`; only this caller stops waiting for it.
   */
  signal?: AbortSignal | undefined;
  /**
   * For a transaction: whether the caller keeps its nonce held when the call ends with an error
   * that {@link outstandingNonce} knows, so that the error says how that hold ends.
   */
  holdsNonce?: boolean | undefined;
}

/** The nonce of each `core.signer.transaction-outstanding` error the signer threw (#537). */
const outstandingNonces = new WeakMap<Error, bigint>();

/**
 * The nonce of a transaction the provider may still sign: set when `error` is the error of a
 * transaction signature that timed out or was cancelled after the request reached a provider
 * whose adapter sets `signTransactionOutlivesAbort` (`core.signer.transaction-outstanding`). The
 * provider may still sign the transaction and keep it where others can broadcast it, so a caller
 * that sends must keep the nonce held, and never sign a second transaction with it (gap over
 * duplicate).
 *
 * @param error - Anything a signer call threw.
 * @returns The transaction's nonce, or `undefined` for any other error.
 */
export function outstandingNonce(error: unknown): bigint | undefined {
  // Stryker disable next-line ConditionalExpression: WeakMap.get returns undefined for a key that is not an object, so the check only narrows the type
  return error instanceof Error ? outstandingNonces.get(error) : undefined;
}

/** A provider's id for a request, as the core shows one: a UUID. Anything else is not shown. */
const PROVIDER_REQUEST_ID = /^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;

/** How `core.signer.transaction-outstanding` names the request, the provider and the rejection. */
interface OutstandingWords {
  who: string;
  request: (id: string | undefined) => string;
  reject: string;
}

/** The words for Turnkey, whose requests are activities, and for any other provider. */
const OUTSTANDING_WORDS: { turnkey: OutstandingWords; other: OutstandingWords } = {
  turnkey: {
    who: "Turnkey",
    request: (id) =>
      id === undefined
        ? "its activity id is not known: look for the account's newest sign_transaction activity"
        : `activity ${id}`,
    reject: "Reject the activity in the Turnkey dashboard",
  },
  other: {
    who: "The provider",
    request: (id) => (id === undefined ? "its request id is not known" : `request ${id}`),
    reject: "Reject the request at the provider",
  },
};

/**
 * Builds the error a transaction signature fails with when it timed out or was cancelled after
 * the adapter reported its request sent: the reason, and the provider's id for the request.
 */
type OutstandingError = (
  reason: string,
  providerRequestId: string | undefined,
) => HardhatPluginError;

/** Largest delay Node's timers accept; larger values fire after 1 ms. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

const DIGEST_LENGTH = 32;

/** What the signer knows about its key once resolved. */
interface KeyIdentity {
  address: string;
  /** Absent for address-only adapters until the first signature reveals it. */
  publicKey?: Uint8Array | undefined;
}

/**
 * A transaction for {@link KmsSigner.signTransaction}: what the adapter's `signTransaction`
 * receives, without the digest, which the signer computes itself.
 */
export interface TransactionToSign {
  /** The unsigned serialized transaction, whose keccak-256 is signed. */
  unsigned: Uint8Array;
  /** Its EIP-2718 type number, 0 for legacy. */
  type: number;
  /** Its chain id. */
  chainId: bigint;
  /** Its nonce, for the error that keeps it held when the provider may still sign it. */
  nonce: bigint;
}

/** What is being signed, which decides the digest, the adapter method and the final check. */
type SignRequest =
  | { kind: "digest"; digest: Uint8Array }
  | { kind: "message"; message: Uint8Array }
  | { kind: "typedData"; typedData: TypedData }
  | ({ kind: "transaction" } & TransactionToSign);

/** One attempt's adapter call, and the adapter method it calls, for debug output. */
interface AdapterCall {
  method: string;
  run: (ctx: SignContext) => Promise<SignatureOutput>;
  /**
   * The nonce of the transaction, when `signTransaction` signs one: only that call can leave a
   * signed transaction at the provider after the core gives up on it.
   */
  nonce?: bigint;
}

/**
 * Provider-agnostic signer. Wraps one {@link KmsKeyAdapter} and owns every cryptographic check:
 * address pinning, low-S normalization, parity recovery and verification of each signature.
 */
export class KmsSigner {
  readonly #adapter: KmsKeyAdapter;
  readonly #description: KeyDescription;
  readonly #displayId: string;
  readonly #options: KmsSignerOptions;
  readonly #timers: Timers;
  /** The adapter's `signTransactionOutlivesAbort`, read once. */
  readonly #outlivesAbort: boolean;
  #identity: Promise<KeyIdentity> | undefined;

  /**
   * @param adapter - The provider adapter for one key.
   * @param options - Pinning, timeout and UI options.
   */
  public constructor(adapter: KmsKeyAdapter, options: KmsSignerOptions) {
    // Described once: adapters come from third-party code, and error paths must not call back into it.
    const description = adapter.describe();
    const context = {
      provider: description.provider,
      key: options.displayId ?? description.displayId,
    };
    if (
      adapter.getPublicKey === undefined &&
      adapter.getAddress === undefined &&
      options.expectedAddress === undefined
    ) {
      throw catalogError(ERRORS.signerNoIdentity, {}, context);
    }
    if (
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw catalogError(ERRORS.signerTimeoutRange, { timeout: options.timeoutMs }, context);
    }
    let expectedAddress = options.expectedAddress;
    if (expectedAddress !== undefined) {
      try {
        expectedAddress = toChecksumAddress(expectedAddress);
      } catch (error) {
        if (error instanceof InvalidAddressError) {
          throw catalogError(ERRORS.signerAddressInvalid, { reason: error.message }, context);
        }
        throw error;
      }
    }
    this.#adapter = adapter;
    this.#description = Object.freeze({ ...description });
    this.#displayId = options.displayId ?? description.displayId;
    this.#options = { ...options, expectedAddress };
    this.#timers = options.timers ?? systemTimers;
    this.#outlivesAbort = adapter.signTransactionOutlivesAbort === true;
  }

  /**
   * Describes the key.
   *
   * @returns The provider, pinned id and display id.
   */
  public describe(): KeyDescription {
    return this.#description;
  }

  /**
   * Returns the key's checksummed address, resolving and pin-checking it on first use.
   *
   * @returns The address.
   */
  public async getAddress(): Promise<string> {
    return (await this.#resolveIdentity()).address;
  }

  /**
   * Returns the key's address as the provider reports it, checked against the `address` pin.
   * Unlike {@link KmsSigner.getAddress}, it asks an address-only provider even when the key has a
   * pin, which signing does not need.
   *
   * @returns The checksummed address, and whether the provider confirmed it. `confirmed` is
   * `false` only for a pinned key whose adapter can report neither a public key nor an address:
   * the address is then the pin, which the first signature checks.
   */
  public async confirmedAddress(): Promise<{ address: string; confirmed: boolean }> {
    const expected = this.#options.expectedAddress;
    if (this.#adapter.getPublicKey !== undefined || expected === undefined) {
      return { address: await this.getAddress(), confirmed: true };
    }
    const getAddress = this.#adapter.getAddress?.bind(this.#adapter);
    if (getAddress === undefined) {
      return { address: expected, confirmed: false };
    }
    const address = await this.#call("get address", async (ctx) =>
      toChecksumAddress(await getAddress(ctx)),
    );
    this.#assertPin(address);
    return { address, confirmed: true };
  }

  /**
   * Returns the key's uncompressed public key, resolving and pin-checking it on first use.
   *
   * @param options - The caller's signal, if any.
   * @returns The 65-byte public key, starting with `0x04`.
   * @throws If the adapter returns only an address and the key has not signed yet, so the public
   * key is unknown.
   */
  public async getPublicKey(options: SignerCallOptions = {}): Promise<Uint8Array> {
    const { publicKey } = await this.#identityFor("get public key", options.signal);
    if (publicKey === undefined) {
      throw this.#error("get public key", ERRORS.signerAddressOnly, {});
    }
    return publicKey.slice();
  }

  /**
   * Signs a 32-byte digest.
   *
   * @param digest - The digest.
   * @param options - The caller's signal, if any.
   * @returns The normalized, verified signature.
   */
  public async signDigest(
    digest: Uint8Array,
    options: SignerCallOptions = {},
  ): Promise<RecoverableSignature> {
    return await this.#sign({ kind: "digest", digest }, options);
  }

  /**
   * Signs a transaction's digest: the keccak-256 of `transaction.unsigned`, which the signer
   * computes from its own copy of the bytes. It calls the adapter's `signTransaction` when present,
   * and `signDigest` otherwise. Either way the signature is verified against that digest and the
   * key. The caller adds the signature to the same unsigned transaction and checks the sender.
   *
   * @param transaction - The unsigned transaction's bytes, type and chain id.
   * @param options - The caller's signal, if any.
   * @returns The normalized, verified signature.
   */
  public async signTransaction(
    transaction: TransactionToSign,
    options: SignerCallOptions = {},
  ): Promise<RecoverableSignature> {
    // Copied once: the digest and every attempt's adapter payload come from this copy, so a caller
    // that changes its array later cannot change what is signed.
    const request: SignRequest = {
      kind: "transaction",
      unsigned: new Uint8Array(transaction.unsigned),
      type: transaction.type,
      chainId: transaction.chainId,
      nonce: transaction.nonce,
    };
    return await this.#sign(request, options);
  }

  /**
   * Signs an EIP-191 personal message and returns it in RPC form.
   *
   * @param message - The message bytes.
   * @param options - The caller's signal, if any.
   * @returns `0x`-prefixed `r || s || v`.
   */
  public async signPersonalMessage(
    message: Uint8Array,
    options: SignerCallOptions = {},
  ): Promise<string> {
    const signature = toRpcSignature(await this.#sign({ kind: "message", message }, options));
    const { address } = await this.#resolveIdentity();
    if (!verifyPersonalMessageSignature(signature, message, address)) {
      throw this.#error("sign message", ERRORS.signerEip191Failed, {});
    }
    return signature;
  }

  /**
   * Signs EIP-712 typed data and returns it in RPC form.
   *
   * @param typedData - The typed data.
   * @param options - The caller's signal, if any.
   * @returns `0x`-prefixed `r || s || v`.
   */
  public async signTypedData(
    typedData: TypedData,
    options: SignerCallOptions = {},
  ): Promise<string> {
    const signature = toRpcSignature(await this.#sign({ kind: "typedData", typedData }, options));
    const { address } = await this.#resolveIdentity();
    if (!verifyTypedDataSignature(signature, typedData, address)) {
      throw this.#error("sign typed data", ERRORS.signerEip712Failed, {});
    }
    return signature;
  }

  /**
   * Releases the adapter's resources.
   *
   * @returns A promise that settles when the adapter is closed.
   */
  public async close(): Promise<void> {
    await this.#adapter.close?.();
  }

  async #resolveIdentity(): Promise<KeyIdentity> {
    this.#identity ??= this.#loadIdentity().catch((error: unknown) => {
      // Never cache a failure: the next call retries.
      this.#identity = undefined;
      throw error;
    });
    return await this.#identity;
  }

  /**
   * Resolves the identity for one caller. The lookup is shared by every caller of this signer, so
   * the caller's signal only stops this caller's wait, never the lookup.
   */
  async #identityFor(operation: string, signal: AbortSignal | undefined): Promise<KeyIdentity> {
    if (signal === undefined) {
      return await this.#resolveIdentity();
    }
    try {
      return await untilCancelled(this.#resolveIdentity(), signal);
    } catch (error) {
      if (error instanceof CancelledError) {
        throw this.#error(operation, ERRORS.signerCancelled, {});
      }
      throw error;
    }
  }

  async #loadIdentity(): Promise<KeyIdentity> {
    const expected = this.#options.expectedAddress;
    const getPublicKey = this.#adapter.getPublicKey?.bind(this.#adapter);
    if (getPublicKey !== undefined) {
      // Kept for every later signature check: copy the key, then check the copy, so the adapter
      // cannot change or shrink the bytes it returned, and an object that reads differently each
      // time cannot pass the check with one key and be kept as another. Not `.slice()`: on a
      // Node `Buffer` that returns a view of the same memory.
      const publicKey = await this.#call("get public key", async (ctx) =>
        assertOnCurve(new Uint8Array(await getPublicKey(ctx))),
      );
      const address = addressFromPublicKey(publicKey);
      log("%s: public key derives to %s", this.#displayId, address);
      this.#assertPin(address);
      return { address, publicKey };
    }
    if (expected !== undefined) {
      // Address-only adapter with a pin: the first signature proves the key matches it.
      return { address: expected };
    }
    const getAddress = this.#adapter.getAddress?.bind(this.#adapter);
    if (getAddress === undefined) {
      throw this.#error("get address", ERRORS.signerCannotIdentify, {});
    }
    return {
      address: await this.#call("get address", async (ctx) =>
        toChecksumAddress(await getAddress(ctx)),
      ),
    };
  }

  #assertPin(address: string): void {
    const expected = this.#options.expectedAddress;
    if (expected !== undefined && !sameAddress(expected, address)) {
      throw this.#error("check address", ERRORS.addressMismatch, { address, expected });
    }
  }

  async #sign(request: SignRequest, options: SignerCallOptions): Promise<RecoverableSignature> {
    const { signal } = options;
    if (request.kind === "digest" && request.digest.length !== DIGEST_LENGTH) {
      // A caller error: never send it to the provider, and never retry it.
      throw this.#error("sign", ERRORS.signerDigestLength, {
        expected: DIGEST_LENGTH,
        length: request.digest.length,
      });
    }
    const identity = await this.#identityFor("sign", signal);
    const digest = digestOf(request);
    try {
      return await this.#signOnce(request, digest, identity, options);
    } catch (error) {
      if (!(error instanceof InvalidSignatureError)) {
        throw error;
      }
      // A fresh signature once: a transient backend fault must not become a silent wrong key. Not
      // after the caller's abort: the retry's call refuses to start.
      log("%s: invalid signature (%s), asking for a fresh one", this.#displayId, error.message);
      try {
        return await this.#signOnce(request, digest, identity, options);
      } catch (retryError) {
        if (retryError instanceof InvalidSignatureError) {
          throw this.#error("sign", ERRORS.signerInvalidSignature, { reason: retryError.message });
        }
        throw retryError;
      }
    }
  }

  async #signOnce(
    request: SignRequest,
    digest: Uint8Array,
    identity: KeyIdentity,
    options: SignerCallOptions,
  ): Promise<RecoverableSignature> {
    // Built before the call, so that a payload the signer cannot copy is not blamed on the provider.
    const call = this.#adapterCall(request, digest);
    log("%s: sign with %s", this.#displayId, call.method);
    const output = await this.#call(
      "sign",
      call.run,
      options.signal,
      this.#outstandingError(call.nonce, options.holdsNonce === true),
    );
    if (identity.publicKey !== undefined) {
      return normalizeSignature(output, digest, identity.publicKey);
    }
    // Address-only key: recover the public key, check it matches the address, then keep it. The
    // recovered key is a new array from the curve library, not the adapter's, so it needs no copy.
    const recovered = recoverForAddress(output, digest, identity.address);
    identity.publicKey = recovered.publicKey;
    return normalizeSignature(output, digest, recovered.publicKey);
  }

  /**
   * Builds one attempt's adapter call. The adapter gets its own copies, never the signer's or the
   * caller's objects: the signer checks the signature against `digest`, also on the retry, and
   * the final EIP-191 and EIP-712 checks read the caller's message and typed data again. An
   * adapter that changes what it received must not change what the signature is checked against.
   */
  #adapterCall(request: SignRequest, digest: Uint8Array): AdapterCall {
    const adapter = this.#adapter;
    const signTypedData = adapter.signTypedData?.bind(adapter);
    if (request.kind === "typedData" && signTypedData !== undefined) {
      const payload = {
        typedData: this.#copyTypedData(request.typedData),
        digest: new Uint8Array(digest),
      };
      return { method: "signTypedData", run: async (ctx) => await signTypedData(payload, ctx) };
    }
    const signMessage = adapter.signMessage?.bind(adapter);
    if (request.kind === "message" && signMessage !== undefined) {
      const payload = { message: new Uint8Array(request.message), digest: new Uint8Array(digest) };
      return { method: "signMessage", run: async (ctx) => await signMessage(payload, ctx) };
    }
    const signTransaction = adapter.signTransaction?.bind(adapter);
    if (request.kind === "transaction" && signTransaction !== undefined) {
      const payload = {
        unsigned: new Uint8Array(request.unsigned),
        digest: new Uint8Array(digest),
        type: request.type,
        chainId: request.chainId,
      };
      return {
        method: "signTransaction",
        run: async (ctx) => await signTransaction(payload, ctx),
        nonce: request.nonce,
      };
    }
    const signDigest = adapter.signDigest?.bind(adapter);
    if (signDigest !== undefined) {
      const payload = { digest: new Uint8Array(digest) };
      return { method: "signDigest", run: async (ctx) => await signDigest(payload, ctx) };
    }
    throw this.#error("sign", ERRORS.signerCannotSign, { kind: REQUEST_KIND_NAMES[request.kind] });
  }

  #copyTypedData(typedData: TypedData): TypedData {
    try {
      return structuredClone(typedData);
    } catch {
      throw this.#error("sign", ERRORS.typedDataInvalid, {
        reason: catalogMessage(ERRORS.typedDataPlainData, {}),
      });
    }
  }

  /**
   * The error of a transaction signature that the provider may still complete, when the adapter
   * says that it may (`signTransactionOutlivesAbort`) and `signTransaction` signs the transaction
   * with this nonce; otherwise `undefined`.
   */
  #outstandingError(nonce: bigint | undefined, holdsNonce: boolean): OutstandingError | undefined {
    if (!this.#outlivesAbort || nonce === undefined) {
      return undefined;
    }
    const words =
      this.#description.provider === "turnkey"
        ? OUTSTANDING_WORDS.turnkey
        : OUTSTANDING_WORDS.other;
    return (reason, providerRequestId) => {
      const error = catalogError(
        ERRORS.signerTransactionOutstanding,
        {
          reason,
          who: words.who,
          request: words.request(providerRequestId),
          nonce,
          reject: words.reject,
          hold: holdsNonce
            ? `. Until a transaction with nonce ${nonce} reaches the node through this network connection, or the connection closes, the connection's sends from this account skip nonce ${nonce}, so they wait behind a gap that the replacement fills`
            : "",
        },
        // The operation as Turnkey's own transaction errors name it, not the signer's `sign`.
        {
          provider: this.#description.provider,
          operation: "sign transaction",
          key: this.#displayId,
        },
      );
      outstandingNonces.set(error, nonce);
      return error;
    };
  }

  async #call<T>(
    operation: string,
    run: (ctx: SignContext) => Promise<T>,
    callerSignal?: AbortSignal,
    outstanding?: OutstandingError,
  ): Promise<T> {
    const requestId = randomUUID();
    const started = Date.now();
    const key = this.#displayId;
    log("%s: %s (request %s)", key, operation, requestId);
    // What the adapter said about its request: whether it may be at the provider, and its id.
    let sent = false;
    let sentId: string | undefined;
    try {
      const result = await withTimeout(
        async (signal) =>
          await run({
            signal,
            displayMessage: async (message) => {
              await this.#options.displayMessage(message);
            },
            requestId,
            requestSent: (providerRequestId) => {
              sent = true;
              // A string only: an object could pass the test and print other text later.
              if (
                typeof providerRequestId === "string" &&
                PROVIDER_REQUEST_ID.test(providerRequestId)
              ) {
                sentId = providerRequestId;
              }
            },
          }),
        this.#options.timeoutMs,
        this.#timers,
        callerSignal,
      );
      log("%s: %s done in %d ms", key, operation, Date.now() - started);
      return result;
    } catch (error) {
      log("%s: %s failed after %d ms (%s)", key, operation, Date.now() - started, errorName(error));
      if (error instanceof HardhatPluginError || error instanceof InvalidSignatureError) {
        throw error;
      }
      if (error instanceof InvalidPublicKeyError || error instanceof InvalidAddressError) {
        // Our own message about the key material, safe to show.
        throw this.#error(operation, ERRORS.signerKeyMaterial, { reason: error.message });
      }
      if (error instanceof TimeoutError) {
        const timeout = this.#options.timeoutMs;
        if (sent && outstanding !== undefined) {
          throw outstanding(catalogMessage(ERRORS.signerNoAnswer, { timeout }), sentId);
        }
        throw this.#error(operation, ERRORS.signerNoAnswer, { timeout });
      }
      if (error instanceof CancelledError) {
        if (sent && outstanding !== undefined) {
          throw outstanding(catalogMessage(ERRORS.signerCancelled, {}), sentId);
        }
        throw this.#error(operation, ERRORS.signerCancelled, {});
      }
      // Only the error's class name: SDK errors can carry request metadata and headers.
      throw this.#error(operation, ERRORS.signerCallFailed, { errorName: errorName(error) });
    }
  }

  #error<Template extends string>(
    operation: string,
    entry: ErrorEntry<Template, "error">,
    params: TemplateParams<Template>,
  ): HardhatPluginError {
    const { provider } = this.#description;
    const displayId = this.#displayId;
    return catalogError(entry, params, { provider, operation, key: displayId });
  }
}

function digestOf(request: SignRequest): Uint8Array {
  if (request.kind === "digest") {
    return request.digest;
  }
  if (request.kind === "message") {
    return personalMessageDigest(request.message);
  }
  if (request.kind === "transaction") {
    return keccak_256(request.unsigned);
  }
  return typedDataDigest(request.typedData);
}

const REQUEST_KIND_NAMES: Record<SignRequest["kind"], string> = {
  digest: "digest",
  message: "personal message",
  typedData: "typed-data payload",
  transaction: "transaction",
};

function recoverForAddress(
  output: SignatureOutput,
  digest: Uint8Array,
  address: string,
): { publicKey: Uint8Array } {
  const { r, s } = parseSignature(output);
  const lowS = toLowS(s);
  for (const yParity of [0, 1] as const) {
    const publicKey = recoverPublicKey(digest, r, lowS, yParity);
    if (publicKey !== undefined && sameAddress(addressFromPublicKey(publicKey), address)) {
      return { publicKey };
    }
  }
  throw new InvalidSignatureError(catalogMessage(ERRORS.signatureNotConfiguredAddress, {}));
}
