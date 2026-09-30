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
import { kmsDebug } from "../debug.ts";
import { kmsError } from "../errors.ts";
import { systemTimers, TimeoutError, type Timers, withTimeout } from "./timeout.ts";
import type { KeyDescription, KmsKeyAdapter, SignContext } from "./types.ts";

const log = kmsDebug("signer");

/** Options for a {@link KmsSigner}. */
export interface KmsSignerOptions {
  /** The address the key must derive to. Checked before the first signature is released. */
  expectedAddress?: string | undefined;
  /** Time budget for each provider call, in milliseconds: an integer from 1 to 2^31 - 1. */
  timeoutMs: number;
  /** Shows a status line to the user. */
  displayMessage(message: string): Promise<void>;
  /** Timer functions, for tests. */
  timers?: Timers | undefined;
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
    const context = { provider: description.provider, key: description.displayId };
    if (
      adapter.getPublicKey === undefined &&
      adapter.getAddress === undefined &&
      options.expectedAddress === undefined
    ) {
      throw kmsError(
        "the adapter can neither return a public key nor an address; set an `address` pin",
        context,
      );
    }
    if (
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw kmsError(
        `the timeout must be an integer from 1 to ${MAX_TIMEOUT_MS} ms, got ${options.timeoutMs}`,
        context,
      );
    }
    let expectedAddress = options.expectedAddress;
    if (expectedAddress !== undefined) {
      try {
        expectedAddress = toChecksumAddress(expectedAddress);
      } catch (error) {
        if (error instanceof InvalidAddressError) {
          throw kmsError(`the configured address is invalid: ${error.message}`, context);
        }
        throw error;
      }
    }
    this.#adapter = adapter;
    this.#description = Object.freeze({ ...description });
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
   * Signs a 32-byte digest.
   *
   * @param digest - The digest.
   * @returns The normalized, verified signature.
   */
  public async signDigest(digest: Uint8Array): Promise<RecoverableSignature> {
    return await this.#sign({ kind: "digest", digest });
  }

  /**
   * Signs an EIP-191 personal message and returns it in RPC form.
   *
   * @param message - The message bytes.
   * @returns `0x`-prefixed `r || s || v`.
   */
  public async signPersonalMessage(message: Uint8Array): Promise<string> {
    const signature = toRpcSignature(await this.#sign({ kind: "message", message }));
    const { address } = await this.#resolveIdentity();
    if (!verifyPersonalMessageSignature(signature, message, address)) {
      throw this.#error("sign message", "the signature failed EIP-191 verification");
    }
    return signature;
  }

  /**
   * Signs EIP-712 typed data and returns it in RPC form.
   *
   * @param typedData - The typed data.
   * @returns `0x`-prefixed `r || s || v`.
   */
  public async signTypedData(typedData: TypedData): Promise<string> {
    const signature = toRpcSignature(await this.#sign({ kind: "typedData", typedData }));
    const { address } = await this.#resolveIdentity();
    if (!verifyTypedDataSignature(signature, typedData, address)) {
      throw this.#error("sign typed data", "the signature failed EIP-712 verification");
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

  async #loadIdentity(): Promise<KeyIdentity> {
    const expected = this.#options.expectedAddress;
    const getPublicKey = this.#adapter.getPublicKey?.bind(this.#adapter);
    if (getPublicKey !== undefined) {
      const publicKey = await this.#call("get public key", async (ctx) =>
        assertOnCurve(await getPublicKey(ctx)),
      );
      const address = addressFromPublicKey(publicKey);
      log("%s: public key derives to %s", this.#description.displayId, address);
      this.#assertPin(address);
      return { address, publicKey };
    }
    if (expected !== undefined) {
      // Address-only adapter with a pin: the first signature proves the key matches it.
      return { address: expected };
    }
    const getAddress = this.#adapter.getAddress?.bind(this.#adapter);
    if (getAddress === undefined) {
      throw this.#error("get address", "the adapter cannot identify its key");
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
      throw this.#error(
        "check address",
        `the key derives to ${address}, but the configured address is ${expected}. ` +
          "If the key was rotated or an alias now points to another key, update the configuration.",
      );
    }
  }

  async #sign(request: SignRequest): Promise<RecoverableSignature> {
    if (request.kind === "digest" && request.digest.length !== DIGEST_LENGTH) {
      // A caller error: never send it to the provider, and never retry it.
      throw this.#error(
        "sign",
        `expected a ${DIGEST_LENGTH}-byte digest, got ${request.digest.length} bytes`,
      );
    }
    const identity = await this.#resolveIdentity();
    const digest = digestOf(request);
    try {
      return await this.#signOnce(request, digest, identity);
    } catch (error) {
      if (!(error instanceof InvalidSignatureError)) {
        throw error;
      }
      // A fresh signature once: a transient backend fault must not become a silent wrong key.
      log(
        "%s: invalid signature (%s), asking for a fresh one",
        this.#description.displayId,
        error.message,
      );
      try {
        return await this.#signOnce(request, digest, identity);
      } catch (retryError) {
        if (retryError instanceof InvalidSignatureError) {
          throw this.#error(
            "sign",
            `the provider returned an invalid signature (${retryError.message})`,
          );
        }
        throw retryError;
      }
    }
  }

  async #signOnce(
    request: SignRequest,
    digest: Uint8Array,
    identity: KeyIdentity,
  ): Promise<RecoverableSignature> {
    const output = await this.#call("sign", (ctx) => this.#invokeAdapter(request, digest, ctx));
    if (identity.publicKey !== undefined) {
      return normalizeSignature(output, digest, identity.publicKey);
    }
    // Address-only key: recover the public key, check it matches the address, then keep it.
    const recovered = recoverForAddress(output, digest, identity.address);
    identity.publicKey = recovered.publicKey;
    return normalizeSignature(output, digest, recovered.publicKey);
  }

  async #invokeAdapter(
    request: SignRequest,
    digest: Uint8Array,
    ctx: SignContext,
  ): Promise<SignatureOutput> {
    const adapter = this.#adapter;
    if (request.kind === "typedData" && adapter.signTypedData !== undefined) {
      return await adapter.signTypedData({ typedData: request.typedData, digest }, ctx);
    }
    if (request.kind === "message" && adapter.signMessage !== undefined) {
      return await adapter.signMessage({ message: request.message, digest }, ctx);
    }
    if (adapter.signDigest !== undefined) {
      return await adapter.signDigest({ digest }, ctx);
    }
    throw this.#error("sign", `the provider cannot sign a ${REQUEST_KIND_NAMES[request.kind]}`);
  }

  async #call<T>(operation: string, run: (ctx: SignContext) => Promise<T>): Promise<T> {
    const requestId = randomUUID();
    const started = Date.now();
    const key = this.#description.displayId;
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
        throw this.#error(operation, error.message);
      }
      if (error instanceof TimeoutError) {
        throw this.#error(operation, `no answer within ${this.#options.timeoutMs} ms`);
      }
      // Only the error's class name: SDK errors can carry request metadata and headers.
      throw this.#error(operation, `the provider call failed (${errorName(error)})`);
    }
  }

  #error(operation: string, message: string): HardhatPluginError {
    const { provider, displayId } = this.#description;
    return kmsError(message, { provider, operation, key: displayId });
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
  throw new InvalidSignatureError("the signature does not recover to the configured address");
}

function errorName(error: unknown): string {
  // The name comes from the provider SDK; keep it only if it looks like a class name.
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)) {
    return error.name;
  }
  return error instanceof Error ? "Error" : typeof error;
}
