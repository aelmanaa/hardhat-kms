// The send guard: the process-global send lock, the nonce high-water mark and the retry cache.
// See "Nonces and the send lock" and "Retries after broadcast" in docs/contributor/transactions.md.
import { AsyncLocalStorage } from "node:async_hooks";

import { HardhatPluginError } from "hardhat/plugins";

import { PLUGIN_ID } from "../constants.ts";
import { ERRORS } from "../error-catalog.ts";
import { catalogError } from "../errors.ts";
import { systemTimers, type Timers } from "../signer/timeout.ts";

/** How long a retry entry lives after a failed broadcast. */
export const RETRY_TTL_MS = 120_000;

/** The most retry entries a connection keeps; a new entry beyond it drops the oldest. */
export const MAX_RETRY_ENTRIES = 256;

/**
 * The error of a send whose outcome is unknown: the transaction was handed to the node, but no
 * answer came back. Its JSON-RPC code is -32000, the generic server error, so clients read it as
 * an RPC error and not as an unknown (-1) or internal (-32603) error, which some retry layers
 * repeat. viem itself never retries a send. It carries the transaction hash as `transactionHash`,
 * where Hardhat Ignition looks for the hash of a transaction that may have been sent, and in
 * `data.hash`.
 */
export class SendOutcomeUnknownError extends HardhatPluginError {
  /** The JSON-RPC error code. */
  public readonly code = -32000;
  /** The transaction hash, for clients that read JSON-RPC error data. */
  public readonly data: { hash: string };
  /** The transaction hash. */
  public readonly transactionHash: string;

  /**
   * @param message - The error message.
   * @param hash - The transaction hash.
   */
  public constructor(message: string, hash: string) {
    super(PLUGIN_ID, message);
    this.data = { hash };
    this.transactionHash = hash;
  }
}

/**
 * How long a send waits in its account's queue with no progress before it fails. Progress is the
 * lock passing to the next send. Not configurable in 1.0.
 */
export const SEND_LOCK_STALL_MS = 120_000;

/** The most sends that may wait for one account's send lock. Not configurable in 1.0. */
export const MAX_SEND_LOCK_WAITERS = 1024;

/** A send waiting for its turn. */
interface Waiter {
  /** Gives the lock to this waiter. */
  grant: () => void;
  /** Starts this waiter's no-progress timer again. */
  restart: () => void;
}

/** A held send lock and the sends waiting for it, in order. */
interface SendLock {
  readonly waiters: Waiter[];
}

/** One hold of a send lock, as the async context of its holder sees it. */
interface Hold {
  readonly key: string;
  released: boolean;
}

/** The held send locks, by lock key. Process-global: every runtime shares it. */
const locks = new Map<string, SendLock>();

/**
 * The locks the current async context holds. Work started inside a holder inherits its store,
 * including work that outlives it, so a hold counts only until it is released.
 */
const holds = new AsyncLocalStorage<readonly Hold[]>();

/**
 * Names the account and chain of a lock key (`chainId:from`) for an error message.
 *
 * @param key - The lock key.
 * @returns A description such as `0xabc… on chain 1`.
 */
function describeKey(key: string): string {
  const colon = key.indexOf(":");
  return colon === -1 ? key : `${key.slice(colon + 1)} on chain ${key.slice(0, colon)}`;
}

/**
 * Waits for the turn of a send behind a held lock. Fails at once when {@link MAX_SEND_LOCK_WAITERS}
 * sends already wait, and after {@link SEND_LOCK_STALL_MS} without the lock passing to a new holder.
 *
 * @param key - The lock key.
 * @param lock - The held lock.
 * @param timers - Timer functions for the no-progress limit.
 */
async function waitForTurn(key: string, lock: SendLock, timers: Timers): Promise<void> {
  if (lock.waiters.length >= MAX_SEND_LOCK_WAITERS) {
    throw catalogError(ERRORS.sendWaitersFull, {
      account: describeKey(key),
      limit: MAX_SEND_LOCK_WAITERS,
    });
  }
  await new Promise<void>((resolve, reject) => {
    let cancel: (() => void) | undefined;
    const waiter: Waiter = {
      grant: () => {
        cancel?.();
        resolve();
      },
      restart: () => {
        cancel?.();
        cancel = timers.setTimeout(() => {
          const index = lock.waiters.indexOf(waiter);
          if (index === -1) {
            return;
          }
          lock.waiters.splice(index, 1);
          reject(
            catalogError(ERRORS.sendStalled, {
              account: describeKey(key),
              seconds: SEND_LOCK_STALL_MS / 1000,
            }),
          );
        }, SEND_LOCK_STALL_MS);
      },
    };
    lock.waiters.push(waiter);
    waiter.restart();
  });
}

/**
 * Runs `run` while holding the process-global send lock for `key` (`chainId:from`). Callers with
 * the same key run one after the other, in the order they asked; other keys do not wait.
 *
 * A send for a key that the current async context holds, such as one made by a hook during the
 * holder's fill, fails at once: it would wait for itself. A waiting send fails after
 * {@link SEND_LOCK_STALL_MS} with no progress, and no more than {@link MAX_SEND_LOCK_WAITERS} sends
 * wait per key. None of these failures signs or sends anything. The holder's own work is not cut
 * short.
 *
 * @param key - The lock key.
 * @param run - The work to do under the lock.
 * @param timers - Timer functions for the no-progress limit.
 * @returns What `run` returns.
 */
export async function withSendLock<T>(
  key: string,
  run: () => Promise<T>,
  timers: Timers = systemTimers,
): Promise<T> {
  const held = holds.getStore() ?? [];
  if (held.some((hold) => hold.key === key && !hold.released)) {
    throw catalogError(ERRORS.sendReentrant, { account: describeKey(key) });
  }
  let lock = locks.get(key);
  if (lock === undefined) {
    lock = { waiters: [] };
    locks.set(key, lock);
  } else {
    await waitForTurn(key, lock, timers);
  }
  const hold: Hold = { key, released: false };
  try {
    return await holds.run([...held, hold], run);
  } finally {
    hold.released = true;
    const next = lock.waiters.shift();
    if (next === undefined) {
      locks.delete(key);
    } else {
      next.grant();
      // O(waiters) per hand-off; MAX_SEND_LOCK_WAITERS bounds the total cost of draining a queue.
      for (const waiter of lock.waiters) {
        waiter.restart();
      }
    }
  }
}

/**
 * The number of send locks that are held or waited for. Tests use it to check that nothing is
 * left behind.
 *
 * @returns The number of lock keys in use.
 */
export function sendLocksInUse(): number {
  return locks.size;
}

/**
 * Serializes a request's params for the retry cache key. Object keys are sorted, so two requests
 * that differ only in key order get the same key. Every value keeps its type: a string is quoted,
 * a bigint ends in `n`, and bytes are written as `bytes(<hex>)`, so values of different types
 * never collide. A key whose value is `undefined` counts as absent, as it does for the filler.
 *
 * @param value - The caller's params, as copied with `structuredClone`.
 * @returns The serialization, or `undefined` for a value it does not handle (a `Date`, a `Map`,
 * a number that is not finite, and so on). Such a request gets no retry entry.
 */
export function canonicalJson(value: unknown): string | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  }
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (value === undefined) {
    return "undefined";
  }
  if (value instanceof Uint8Array) {
    return `bytes(${Buffer.from(value).toString("hex")})`;
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      const serialized = canonicalJson(item);
      if (serialized === undefined) {
        return undefined;
      }
      items.push(serialized);
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value !== "object") {
    return undefined;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return undefined;
  }
  const fields: string[] = [];
  for (const [key, item] of Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    if (item === undefined) {
      continue;
    }
    const serialized = canonicalJson(item);
    if (serialized === undefined) {
      return undefined;
    }
    fields.push(`${JSON.stringify(key)}:${serialized}`);
  }
  return `{${fields.join(",")}}`;
}

/** A signed transaction, as it was broadcast. */
export interface SentTransaction {
  /** The signed raw transaction, as `0x` hex. */
  raw: string;
  /** Its hash, as `0x` hex. */
  hash: string;
  /** Its nonce. */
  nonce: bigint;
}

interface RetryEntry {
  transaction: SentTransaction;
  cancel: () => void;
}

/** What the send state of a connection needs. */
export interface ConnectionSendsOptions {
  /** Whether to keep a nonce high-water mark; off on `edr-simulated` networks. */
  highWater: boolean;
  /** Timer functions for the retry entries' lifetime. */
  timers?: Timers;
}

/**
 * The send state of one network connection: the nonce high-water mark of each KMS sender, and the
 * retry entries of failed broadcasts. Use it only while holding the sender's send lock.
 */
export class ConnectionSends {
  readonly #highWaterEnabled: boolean;
  readonly #timers: Timers;
  readonly #highWater = new Map<string, bigint>();
  readonly #retries = new Map<string, RetryEntry>();
  /** By sender: the last transaction whose broadcast had no answer, still to be looked up. */
  readonly #uncertain = new Map<string, SentTransaction>();
  #closed = false;

  /**
   * @param options - Whether the high-water mark is on, and the timers.
   */
  public constructor(options: ConnectionSendsOptions) {
    this.#highWaterEnabled = options.highWater;
    this.#timers = options.timers ?? systemTimers;
  }

  /**
   * Chooses the nonce of a send whose caller gave none: `max(pending, highWater + 1)`, so a node
   * that lags on its pending count does not get a nonce that was already used.
   *
   * @param from - The sender's lowercase address.
   * @param pending - The node's pending transaction count for the sender.
   * @returns The nonce to sign.
   */
  public nonceFor(from: string, pending: bigint): bigint {
    const mark = this.#highWaterEnabled ? this.#highWater.get(from) : undefined;
    return mark === undefined || pending > mark ? pending : mark + 1n;
  }

  /**
   * Returns the sender's high-water mark.
   *
   * @param from - The sender's lowercase address.
   * @returns The highest nonce the node accepted on this connection, or `undefined` when there is
   * none or the mark is off.
   */
  public highWaterOf(from: string): bigint | undefined {
    return this.#highWaterEnabled ? this.#highWater.get(from) : undefined;
  }

  /**
   * Records a nonce the node accepted: `highWater = max(highWater, nonce)`.
   *
   * @param from - The sender's lowercase address.
   * @param nonce - The nonce of the accepted transaction.
   */
  public recordSent(from: string, nonce: bigint): void {
    if (!this.#highWaterEnabled) {
      return;
    }
    const mark = this.#highWater.get(from);
    if (mark === undefined || nonce > mark) {
      this.#highWater.set(from, nonce);
    }
  }

  /**
   * Keeps a transaction whose broadcast failed, so that a retry of the same request sends the
   * same bytes. The entry lives for {@link RETRY_TTL_MS}, and replaces an older one for the key.
   *
   * @param key - The retry key: chain id, sender and the caller's params.
   * @param transaction - The signed transaction.
   */
  public rememberFailure(key: string, transaction: SentTransaction): void {
    if (this.#closed) {
      return;
    }
    const existing = this.#retries.get(key);
    if (existing !== undefined) {
      existing.cancel();
      // Deleted first, so the new entry counts as the newest.
      this.#retries.delete(key);
    }
    for (const [oldest, entry] of this.#retries) {
      if (this.#retries.size < MAX_RETRY_ENTRIES) {
        break;
      }
      entry.cancel();
      this.#retries.delete(oldest);
    }
    const entry: RetryEntry = {
      transaction,
      cancel: this.#timers.setTimeout(() => {
        if (this.#retries.get(key) === entry) {
          this.#retries.delete(key);
        }
      }, RETRY_TTL_MS),
    };
    this.#retries.set(key, entry);
  }

  /**
   * Drops the retry entries of a transaction, whatever their key, and cancels their timers. Used
   * when the node does not have the transaction and a later send may take its nonce, so its old
   * bytes must not be sent again.
   *
   * @param hash - The transaction hash.
   */
  public dropRetriesOf(hash: string): void {
    for (const [key, entry] of this.#retries) {
      if (entry.transaction.hash === hash) {
        entry.cancel();
        this.#retries.delete(key);
      }
    }
  }

  /**
   * Takes the retry entry for a key, if one is alive. The entry is removed: it serves one retry.
   *
   * @param key - The retry key.
   * @returns The transaction to send again, or `undefined`.
   */
  public takeRetry(key: string): SentTransaction | undefined {
    const entry = this.#retries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    entry.cancel();
    this.#retries.delete(key);
    return entry.transaction;
  }

  /**
   * Remembers a transaction whose broadcast got no answer, so that the sender's next send can
   * ask the node whether it has it. A newer one replaces it. Without a high-water mark there is
   * nothing to raise, so nothing is kept.
   *
   * @param from - The sender's lowercase address.
   * @param transaction - The transaction.
   */
  public rememberUncertain(from: string, transaction: SentTransaction): void {
    if (this.#closed || !this.#highWaterEnabled) {
      return;
    }
    this.#uncertain.set(from, transaction);
  }

  /**
   * Takes the sender's uncertain transaction, if there is one. It is removed.
   *
   * @param from - The sender's lowercase address.
   * @returns The transaction, or `undefined`.
   */
  public takeUncertain(from: string): SentTransaction | undefined {
    const transaction = this.#uncertain.get(from);
    this.#uncertain.delete(from);
    return transaction;
  }

  /**
   * Forgets the sender's uncertain transaction when it is the one with this hash: the node has
   * answered for it since.
   *
   * @param from - The sender's lowercase address.
   * @param hash - The transaction hash.
   */
  public settleUncertain(from: string, hash: string): void {
    if (this.#uncertain.get(from)?.hash === hash) {
      this.#uncertain.delete(from);
    }
  }

  /**
   * Drops every retry entry and cancels its timer; called when the connection closes. Later
   * failures are not remembered.
   */
  public close(): void {
    this.#closed = true;
    for (const entry of this.#retries.values()) {
      entry.cancel();
    }
    this.#retries.clear();
    this.#highWater.clear();
    this.#uncertain.clear();
  }
}
