import type { HookContext } from "hardhat/types/hooks";

import type { KmsKeyConfig } from "../../types.ts";
import { kmsDebug } from "../debug.ts";
import { createKeyAdapter } from "../providers/create-adapter.ts";
import { KmsSigner } from "./kms-signer.ts";
import { signerIdentity } from "./signer-identity.ts";
import { systemTimers, type Timers } from "./timeout.ts";

const log = kmsDebug("signer");

/** How long the cache waits after its last connection closes before it closes the signers. */
const IDLE_CLOSE_MS = 5000;

/** Shows an adapter's status message to the user. */
export type DisplayMessage = (context: HookContext, message: string) => Promise<void>;

/** Hardhat's own display, through the `userInterruptions` hooks. */
const hardhatDisplay: DisplayMessage = async (context, message) => {
  await context.interruptions.displayMessage("hardhat-kms", message);
};

/**
 * The signers of one Hardhat runtime. A key of a first-party provider is cached by its
 * {@link signerIdentity}, so the copies of a key that Hardhat makes for a connection with config
 * overrides share one signer. Any other key is cached by its config object. Every connection of
 * the runtime shares the signers, so an address is looked up once. Connections are counted for the
 * whole cache, not per signer: when the last one closes, an idle timer closes every signer and its
 * SDK clients, so they do not keep `hardhat run` alive; the next use creates them again.
 */
export class SignerCache {
  readonly #signers = new Map<string | KmsKeyConfig, Promise<KmsSigner>>();
  /** Each key object's identity, computed once so that concurrent first requests agree. */
  readonly #identities = new WeakMap<KmsKeyConfig, Promise<string | undefined>>();
  readonly #timers: Timers;
  #connections = 0;
  /** Calls to {@link SignerCache.withSigner} that have not finished. */
  #active = 0;
  #cancelIdleClose: (() => void) | undefined;
  readonly #display: DisplayMessage;

  /**
   * @param timers - Timer functions, for tests.
   * @param display - Where adapters' status messages go. Defaults to Hardhat's
   * `interruptions.displayMessage`, which prints to standard output.
   */
  public constructor(timers: Timers = systemTimers, display: DisplayMessage = hardhatDisplay) {
    this.#timers = timers;
    this.#display = display;
  }

  /**
   * Runs `use` with the signer for a key, creating its adapter through the `kms` hook on first use.
   * While `use` runs, the idle close waits, so a request in flight keeps its SDK client.
   *
   * @param context - The Hardhat runtime.
   * @param key - The resolved key.
   * @param use - What to do with the signer.
   * @returns What `use` returns.
   */
  public async withSigner<T>(
    context: HookContext,
    key: KmsKeyConfig,
    use: (signer: KmsSigner) => Promise<T>,
  ): Promise<T> {
    this.#active++;
    try {
      return await use(await this.signerFor(context, key));
    } finally {
      this.#active--;
    }
  }

  /**
   * Returns the signer for a key, creating its adapter through the `kms` hook on first use.
   *
   * @param context - The Hardhat runtime.
   * @param key - The resolved key.
   * @returns The signer.
   */
  public async signerFor(context: HookContext, key: KmsKeyConfig): Promise<KmsSigner> {
    const cacheKey = await this.#cacheKey(key);
    let signer = this.#signers.get(cacheKey);
    if (signer === undefined) {
      signer = this.#create(context, key);
      this.#signers.set(cacheKey, signer);
      // Never cache a failure: the next request retries.
      signer.catch(() => {
        if (this.#signers.get(cacheKey) === signer) {
          this.#signers.delete(cacheKey);
        }
      });
    }
    return await signer;
  }

  /**
   * The key's identity, or the key object itself for a third-party key or when the identifier
   * cannot be read. In that case the adapter reads it again and fails with the usual error, and
   * the next request computes the identity again.
   */
  async #cacheKey(key: KmsKeyConfig): Promise<string | KmsKeyConfig> {
    let identity = this.#identities.get(key);
    if (identity === undefined) {
      identity = signerIdentity(key);
      this.#identities.set(key, identity);
      identity.catch(() => {
        if (this.#identities.get(key) === identity) {
          this.#identities.delete(key);
        }
      });
    }
    try {
      return (await identity) ?? key;
    } catch {
      return key;
    }
  }

  /** Counts a new connection, and keeps the signers open while it lasts. */
  public connectionOpened(): void {
    this.#connections++;
    this.#cancelIdleClose?.();
    this.#cancelIdleClose = undefined;
  }

  /** Counts a closed connection; after the last one, closes the signers once idle. */
  public connectionClosed(): void {
    this.#connections = Math.max(0, this.#connections - 1);
    if (this.#connections > 0 || this.#signers.size === 0) {
      return;
    }
    this.#scheduleIdleClose();
  }

  #scheduleIdleClose(): void {
    // The system timers are unref'd: an idle timer never keeps the process running.
    this.#cancelIdleClose?.();
    this.#cancelIdleClose = this.#timers.setTimeout(() => {
      this.#cancelIdleClose = undefined;
      if (this.#connections > 0) {
        return;
      }
      if (this.#active > 0) {
        // A request is still signing: try again later rather than close its client.
        this.#scheduleIdleClose();
        return;
      }
      void this.closeAll();
    }, IDLE_CLOSE_MS);
  }

  /** Closes every signer and empties the cache. Errors from closing are logged, not thrown. */
  public async closeAll(): Promise<void> {
    const signers = [...this.#signers.values()];
    this.#signers.clear();
    log("closing %d signers", signers.length);
    await Promise.all(
      signers.map(async (pending) => {
        try {
          await (await pending).close();
        } catch {
          // A signer that failed to open, or to close, has nothing left to release.
        }
      }),
    );
  }

  async #create(context: HookContext, key: KmsKeyConfig): Promise<KmsSigner> {
    const adapter = await createKeyAdapter(context, key);
    try {
      return new KmsSigner(adapter, {
        expectedAddress: key.address,
        timeoutMs: key.timeoutMs,
        displayId: key.displayId,
        displayMessage: async (message) => {
          await this.#display(context, message);
        },
      });
    } catch (error) {
      // The signer refused the adapter, so nothing else will close it and its clients.
      try {
        await adapter.close?.();
      } catch {
        // The error that refused the adapter is the one to report.
      }
      throw error;
    }
  }
}
