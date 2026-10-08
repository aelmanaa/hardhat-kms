import { randomUUID } from "node:crypto";

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
}

/** Largest delay Node's timers accept; larger values fire after 1 ms. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

const DIGEST_LENGTH = 32;

/** What the signer knows about its key once resolved. */
interface KeyIdentity {
  address: string;
  /** Absent for address-only adapters until the first signature reveals it. */
  publicKey?: Uint8Array | undefined;
}

/** What is being signed, which decides the digest, the adapter method and the final check. */
type SignRequest =
  | { kind: "digest"; digest: Uint8Array }
  | { kind: "message"; message: Uint8Array }
  | { kind: "typedData"; typedData: TypedData };

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
    return await this.#sign({ kind: "digest", digest }, options.signal);
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
    const signature = toRpcSignature(
      await this.#sign({ kind: "message", message }, options.signal),
    );
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
    const signature = toRpcSignature(
      await this.#sign({ kind: "typedData", typedData }, options.signal),
    );
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

  async #sign(
    request: SignRequest,
    signal: AbortSignal | undefined,
  ): Promise<RecoverableSignature> {
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
      return await this.#signOnce(request, digest, identity, signal);
    } catch (error) {
      if (!(error instanceof InvalidSignatureError)) {
        throw error;
      }
      // A fresh signature once: a transient backend fault must not become a silent wrong key. Not
      // after the caller's abort: the retry's call refuses to start.
      log("%s: invalid signature (%s), asking for a fresh one", this.#displayId, error.message);
      try {
        return await this.#signOnce(request, digest, identity, signal);
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
    signal: AbortSignal | undefined,
  ): Promise<RecoverableSignature> {
    // Built before the call, so that a payload the signer cannot copy is not blamed on the provider.
    const call = this.#adapterCall(request, digest);
    const output = await this.#call("sign", call, signal);
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
  #adapterCall(
    request: SignRequest,
    digest: Uint8Array,
  ): (ctx: SignContext) => Promise<SignatureOutput> {
    const adapter = this.#adapter;
    const signTypedData = adapter.signTypedData?.bind(adapter);
    if (request.kind === "typedData" && signTypedData !== undefined) {
      const payload = {
        typedData: this.#copyTypedData(request.typedData),
        digest: new Uint8Array(digest),
      };
      return async (ctx) => await signTypedData(payload, ctx);
    }
    const signMessage = adapter.signMessage?.bind(adapter);
    if (request.kind === "message" && signMessage !== undefined) {
      const payload = { message: new Uint8Array(request.message), digest: new Uint8Array(digest) };
      return async (ctx) => await signMessage(payload, ctx);
    }
    const signDigest = adapter.signDigest?.bind(adapter);
    if (signDigest !== undefined) {
      const payload = { digest: new Uint8Array(digest) };
      return async (ctx) => await signDigest(payload, ctx);
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

  async #call<T>(
    operation: string,
    run: (ctx: SignContext) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const requestId = randomUUID();
    const started = Date.now();
    const key = this.#displayId;
    log("%s: %s (request %s)", key, operation, requestId);
    try {
      const result = await withTimeout(
        async (signal) =>
          await run({
            signal,
            displayMessage: async (message) => {
              await this.#options.displayMessage(message);
            },
            requestId,
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
        throw this.#error(operation, ERRORS.signerNoAnswer, { timeout: this.#options.timeoutMs });
      }
      if (error instanceof CancelledError) {
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
  return typedDataDigest(request.typedData);
}

const REQUEST_KIND_NAMES: Record<SignRequest["kind"], string> = {
  digest: "digest",
  message: "personal message",
  typedData: "typed-data payload",
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
