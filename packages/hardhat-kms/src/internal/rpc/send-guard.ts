// The send guard: the process-global send lock, the nonce high-water mark and the retry cache.
// See "Nonces and the send lock" and "Retries after broadcast" in docs/contributor/transactions.md.
import { AsyncLocalStorage } from "node:async_hooks";

import { max } from "@nomicfoundation/hardhat-utils/bigint";
import { HardhatPluginError } from "hardhat/plugins";

import { PLUGIN_ID } from "../constants.ts";
import { toChecksumAddress } from "../crypto/address.ts";
import { ERRORS } from "../error-catalog.ts";
import { catalogError, catalogMessage } from "../errors.ts";
import { CancelledError, systemTimers, type Timers } from "../signer/timeout.ts";
import { warn } from "../warnings.ts";

/** How long a retry entry lives after a failed broadcast. */
export const RETRY_TTL_MS = 120_000;

/**
 * How long a nonce that a library account's nonce manager handed out keeps counting, when neither
 * its raw transaction nor the client's `reset` ends it first. Not configurable in 1.0.
 */
export const RESERVATION_MS = 60_000;

/** The most retry entries a connection keeps; a new entry beyond it drops the oldest. */
export const MAX_RETRY_ENTRIES = 256;

/**
 * The most sent transactions a connection records per sender with the high-water mark off; a new
 * record beyond it drops the one made first.
 */
export const MAX_SENT_RECORDS = 256;

/**
 * The most uncertain transactions a connection keeps per sender. A new one beyond it settles the
 * one kept first as if the node had it: its nonce counts as used, so the bound can leave a gap but
 * never lets a send reuse a nonce the node may have.
 */
export const MAX_UNCERTAIN_RECORDS = 256;

/**
 * The error of a send whose outcome is unknown: the transaction was handed to the node, but no
 * answer came back. Its JSON-RPC code is -32000, the generic server error, so clients read it as
 * an RPC error and not as an unknown (-1) or internal (-32603) error, which some retry layers
 * repeat. viem does not repeat `eth_sendTransaction`. After this error it sends the request once
 * as `wallet_sendTransaction`, which the plugin refuses for a KMS sender, so the error viem throws
 * has this one in its cause chain. It carries the transaction hash as `transactionHash`, where Hardhat Ignition looks for
 * the hash of a transaction that may have been sent, and in `data.hash`.
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

/** A library account's send that holds its account's send lock, from its nonce to its broadcast. */
interface LibraryHold {
  /** The nonce the send was given. */
  readonly nonce: bigint;
  /**
   * The send state of the connection that gave it: closing that connection ends the hold, only a
   * viem `reset` through that connection can end it, and its raw transaction's outcome is recorded
   * there whichever connection it comes through.
   */
  readonly owner: ConnectionSends;
  /** Ends the hold and releases the lock. */
  readonly end: () => void;
  /** Whether a send waiting behind this hold has printed the wait warning. */
  waitWarned: boolean;
}

/** The library sends that hold a send lock, by lock key. Process-global, as the locks are. */
const libraryHolds = new Map<string, LibraryHold>();

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
export function describeSendKey(key: string): string {
  const colon = key.indexOf(":");
  return colon === -1 ? key : `${key.slice(colon + 1)} on chain ${key.slice(0, colon)}`;
}

/** The cancel function of a timer not yet armed: there is nothing to cancel. */
function noTimer(): void {}

/**
 * Waits for the turn of a send behind a held lock. Fails at once when {@link MAX_SEND_LOCK_WAITERS}
 * sends already wait, after {@link SEND_LOCK_STALL_MS} without the lock passing to a new holder,
 * and when `signal` aborts before the turn comes.
 *
 * @param key - The lock key.
 * @param lock - The held lock.
 * @param timers - Timer functions for the no-progress limit.
 * @param signal - The caller's signal, if any.
 * @throws {CancelledError} If `signal` aborts first, or had aborted before the call.
 */
async function waitForTurn(
  key: string,
  lock: SendLock,
  timers: Timers,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted === true) {
    throw cancelledWait();
  }
  if (lock.waiters.length >= MAX_SEND_LOCK_WAITERS) {
    throw catalogError(ERRORS.sendWaitersFull, {
      account: describeSendKey(key),
      limit: MAX_SEND_LOCK_WAITERS,
    });
  }
  await new Promise<void>((resolve, reject) => {
    // Cancels the waiter's current no-progress timer; there is none until the first restart.
    let cancel: () => void = noTimer;
    /** Takes the waiter out of the queue and fails it; a waiter already granted stays. */
    const leave = (error: Error): void => {
      const index = lock.waiters.indexOf(waiter);
      if (index === -1) {
        return;
      }
      lock.waiters.splice(index, 1);
      cancel();
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = (): void => {
      leave(cancelledWait());
    };
    const waiter: Waiter = {
      grant: () => {
        cancel();
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      restart: () => {
        cancel();
        cancel = timers.setTimeout(() => {
          leave(
            catalogError(ERRORS.sendStalled, {
              account: describeSendKey(key),
              seconds: SEND_LOCK_STALL_MS / 1000,
            }),
          );
        }, SEND_LOCK_STALL_MS);
      },
    };
    // Armed before the waiter joins the queue: when the timers throw, the send fails and leaves no
    // waiter behind that would be granted the lock. This relies on the Timers contract that a
    // callback never runs inside setTimeout itself, as real timers guarantee: a limit that fired
    // here would find no waiter to fail, and the send would wait with no limit until the next
    // hand-off.
    waiter.restart();
    lock.waiters.push(waiter);
    signal?.addEventListener("abort", onAbort);
  });
}

/** The error of a wait for the send lock that the caller's signal ended. */
function cancelledWait(): CancelledError {
  return new CancelledError(catalogMessage(ERRORS.cancelled, {}));
}

/**
 * How long a library account's send may keep its account's send lock when neither its raw
 * transaction nor viem's `reset` ends the hold first. Not configurable in 1.0.
 */
export const LIBRARY_HOLD_MS = 60_000;

/**
 * How long a send waits for its account's send lock before a warning says that a library
 * account's send holds it. Not configurable in 1.0.
 */
export const LIBRARY_WAIT_WARNING_MS = 5000;

/** Where the warnings about library sends are explained. */
const LIBRARY_WARNINGS_DOCS =
  "https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/library-accounts.md#warnings";

/** Where filling a nonce gap is explained. */
const FILL_NONCE_DOCS =
  "https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/uncertain-sends.md#4-fill-a-gap-or-replace-a-transaction";

/** Where looking a transaction up is explained. */
const LOOK_UP_DOCS =
  "https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/uncertain-sends.md#2-look-the-transaction-up";

/**
 * Names the account and chain of a lock key in a warning, with the address checksummed.
 *
 * @param key - The lock key, `chainId:address`.
 * @returns A description such as `0xAbC… on chain 1`.
 */
function describeSendKeyForWarning(key: string): string {
  const colon = key.indexOf(":");
  return `${toChecksumAddress(key.slice(colon + 1))} on chain ${key.slice(0, colon)}`;
}

/**
 * Warns that a send has waited {@link LIBRARY_WAIT_WARNING_MS} for its account's send lock, when a
 * library account's send holds that lock now. Each waiting send arms one timer, so it prints at
 * most once per waiting send, and `waitWarned` limits it to once per hold: a send that waits behind
 * two holds in a row prints one warning, for the hold current when its timer fires.
 *
 * @param key - The lock key.
 */
function warnAboutLibraryWait(key: string): void {
  const hold = libraryHolds.get(key);
  if (hold === undefined || hold.waitWarned) {
    return;
  }
  hold.waitWarned = true;
  warn(
    `a send from ${describeSendKeyForWarning(key)} has waited ${LIBRARY_WAIT_WARNING_MS / 1000} s for a connection.kms.getAccount send that chose nonce ${hold.nonce} and has not broadcast it through the connection. It waits until that raw transaction goes out, viem resets that send, or ${LIBRARY_HOLD_MS / 1000} s after the nonce was chosen. If the library send's client does not send through custom(connection.provider), send it through that transport; see ${LIBRARY_WARNINGS_DOCS}.`,
  );
}

/**
 * Tells whether the current async context holds the send lock for a key, so that a send for that
 * key would wait for itself.
 *
 * @param key - The lock key.
 * @returns Whether it does.
 */
export function holdsSendLock(key: string): boolean {
  // Stryker disable next-line ArrayDeclaration: a string in the array has no key, so some() finds no hold
  return (holds.getStore() ?? []).some((hold) => hold.key === key && !hold.released);
}

/**
 * Runs `run` while holding the process-global send lock for `key` (`chainId:from`). Callers with
 * the same key run one after the other, in the order they asked; other keys do not wait.
 *
 * A send for a key that the current async context holds, such as one made by a hook during the
 * holder's fill, fails at once: it would wait for itself. A waiting send fails after
 * {@link SEND_LOCK_STALL_MS} with no progress, and no more than {@link MAX_SEND_LOCK_WAITERS} sends
 * wait per key. A send whose `signal` aborts while it waits leaves the queue and fails. None of
 * these failures signs or sends anything. The holder's own work is not cut short.
 *
 * @param key - The lock key.
 * @param run - The work to do under the lock.
 * @param timers - Timer functions for the no-progress limit.
 * @param signal - Ends the wait for the lock when it aborts; never the work under it.
 * @returns What `run` returns.
 */
export async function withSendLock<T>(
  key: string,
  run: () => Promise<T>,
  timers: Timers = systemTimers,
  signal?: AbortSignal,
): Promise<T> {
  if (holdsSendLock(key)) {
    throw catalogError(ERRORS.sendReentrant, { account: describeSendKey(key) });
  }
  let lock = locks.get(key);
  if (lock === undefined) {
    lock = { waiters: [] };
    locks.set(key, lock);
  } else {
    const cancelWarning = timers.setTimeout(() => {
      warnAboutLibraryWait(key);
    }, LIBRARY_WAIT_WARNING_MS);
    try {
      await waitForTurn(key, lock, timers, signal);
    } finally {
      cancelWarning();
    }
  }
  const hold: Hold = { key, released: false };
  try {
    // Stryker disable next-line ArrayDeclaration: holdsSendLock, the only reader, skips an entry with no key
    const outer = holds.getStore() ?? [];
    return await holds.run([...outer, hold], run);
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
 * By the send state of the connection that gave the hold, then by lock key: the viem `reset` calls
 * still to come for library sends whose broadcast failed, and which no longer hold the lock, so
 * that they do not end another hold. Such a reset comes through the account's own connection, the
 * hold's owner, so a reset through another connection, or through this one after it closed, never
 * uses one up. A `reset` after a failed `consume` never gets here: the account's nonce manager
 * keeps it.
 */
const pendingResets = new WeakMap<ConnectionSends, Map<string, number>>();

/**
 * Timer functions whose timers keep the process alive, unlike {@link systemTimers}: a send that
 * waits behind a library hold must not see Node end the process before the hold ends.
 */
const keepAliveTimers: Timers = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    return () => {
      clearTimeout(handle);
    };
  },
};

/**
 * Warns that viem's `reset` ended the reservation of a nonce that a library send held until its
 * time limit, while the account has already used a higher nonce. viem resets after any error,
 * including a timeout after the node took the transaction, so the nonce may or may not be a gap;
 * if it is, the account's later transactions wait behind it.
 *
 * @param key - The lock key.
 * @param nonce - The nonce of the gap.
 */
function warnAboutNonceGap(key: string, nonce: bigint): void {
  warn(
    `viem reset a connection.kms.getAccount send from ${describeSendKeyForWarning(key)} with nonce ${nonce} after its ${LIBRARY_HOLD_MS / 1000} s hold ended, and the account has used a higher nonce since. If that send never reached the node, nonce ${nonce} is a gap, and the account's later transactions are not mined until a transaction with nonce ${nonce} is. viem also resets after a timeout, when the node may have the transaction, so check the node for nonce ${nonce} first (${LOOK_UP_DOCS}), and fill the gap only if it is one (${FILL_NONCE_DOCS}).`,
  );
}

/** Warns when a reset releases an ordinary reservation below a nonce the node accepted. */
function warnAboutReservationGap(key: string, nonce: bigint): void {
  warn(
    `viem reset a connection.kms.getAccount send from ${describeSendKeyForWarning(key)} with nonce ${nonce}, and the plugin released its reservation after the node accepted a higher nonce. If that send never reached the node, nonce ${nonce} is a gap, and the account's later transactions are not mined until a transaction with nonce ${nonce} is. viem also resets after a timeout, when the node may have the transaction, so check the node for nonce ${nonce} first (${LOOK_UP_DOCS}), and fill the gap only if it is one, with an explicit nonce (${FILL_NONCE_DOCS}).`,
  );
}

/**
 * Warns that reservations whose send a viem `reset` may have been for ended at their time limit.
 * The reset named no nonce and matched several reservations, so it released none of them
 * ({@link ConnectionSends.resetReservation}). The nonces are free again for the account's sends
 * through its connection; if the failed send had one of them, that nonce is a gap.
 *
 * @param key - The lock key.
 * @param nonces - The nonces whose reservations ended.
 */
function warnAboutOwedReset(key: string, nonces: readonly bigint[]): void {
  const nonce = nonces.join(" or ");
  warn(
    `viem reset one of the connection.kms.getAccount sends from ${describeSendKeyForWarning(key)} that had reserved a nonce, without saying which, so the plugin kept all their nonces. The reservation of nonce ${nonce} has now ended after ${RESERVATION_MS / 1000} s. Automatic sends may still choose a higher nonce. If the send that failed had nonce ${nonce}, that nonce is a gap, and the account's later transactions are not mined until a transaction with it is. Check the node for nonce ${nonce} first (${LOOK_UP_DOCS}), and fill the gap only if it is one, with an explicit nonce (${FILL_NONCE_DOCS}).`,
  );
}

/**
 * Takes the send lock for a library account's send and keeps it after `choose` returns: viem
 * signs and sends the transaction with the chosen nonce itself, in later requests. The hold ends
 * when that raw transaction is broadcast ({@link endLibraryHold}), when viem's `reset` reports
 * that the send failed (`resetLibraryNonce` in the dispatcher), when the owner's connection closes, or after
 * {@link LIBRARY_HOLD_MS}. Sends that wait behind it wait as they wait behind any send. At the time
 * limit the nonce becomes a reservation on the owner first, so the owner's sends through the
 * plugin skip it for {@link RESERVATION_MS} instead of signing it again.
 *
 * When the lock cannot be had, or `choose` fails, nothing is held and the error is thrown.
 *
 * @param key - The lock key.
 * @param owner - The connection's send state.
 * @param choose - Chooses the nonce, under the lock.
 * @param timers - Timer functions for the hold's limit; by default they keep the process alive.
 * @param signal - Ends the wait for the lock when it aborts, as in {@link withSendLock}.
 * @param beforeHold - Checks that the connection is still open after asynchronous nonce selection.
 * @returns The nonce.
 */
export async function holdForLibrary(
  key: string,
  owner: ConnectionSends,
  choose: () => Promise<bigint>,
  timers: Timers = keepAliveTimers,
  signal?: AbortSignal,
  beforeHold: () => void = noTimer,
): Promise<bigint> {
  const control: { acquired?: (nonce: bigint) => void; release?: () => void } = {};
  const acquired = new Promise<bigint>((resolve) => {
    control.acquired = resolve;
  });
  const released = new Promise<void>((resolve) => {
    control.release = resolve;
  });
  const holding = withSendLock(
    key,
    async () => {
      const nonce = await choose();
      beforeHold();
      const cancel = timers.setTimeout(() => {
        // Before the lock passes on: the send waiting for it must skip this nonce.
        owner.reserve(key.slice(key.indexOf(":") + 1), nonce, true);
        warn(
          `a connection.kms.getAccount send from ${describeSendKeyForWarning(key)} chose nonce ${nonce}, and after ${LIBRARY_HOLD_MS / 1000} s it has neither broadcast it through the connection nor been reset by viem, so the plugin released the account's send lock and reserved the nonce: the account's sends through its connection skip it for up to ${RESERVATION_MS / 1000} s. Its raw transaction did not reach the plugin, as with a custom transport over another provider. If it is broadcast after that, it and another send of the account can share the nonce, and either can replace the other or be refused. Send the library account through custom(connection.provider); see ${LIBRARY_WARNINGS_DOCS}.`,
        );
        hold.end();
      }, LIBRARY_HOLD_MS);
      const hold: LibraryHold = {
        nonce,
        owner,
        waitWarned: false,
        // A hold stays in libraryHolds from here until it ends, so this check also makes a second
        // call a no-op, and an old hold's end cannot remove a newer one.
        end: () => {
          if (libraryHolds.get(key) !== hold) {
            return;
          }
          libraryHolds.delete(key);
          cancel();
          // Stryker disable next-line OptionalChaining: the promise executor above set release
          control.release?.();
        },
      };
      libraryHolds.set(key, hold);
      // Stryker disable next-line OptionalChaining: the promise executor above set acquired
      control.acquired?.(nonce);
      await released;
    },
    systemTimers,
    signal,
  );
  // Stryker disable next-line ArrowFunction: holding resolves only after acquired, so the race is already settled
  return await Promise.race([acquired, holding.then(async () => await acquired)]);
}

/**
 * The library send that holds a key's lock.
 *
 * @param key - The lock key.
 * @returns Its nonce, the send state that gave it and how to end it, or `undefined` when no
 * library send holds the lock. The same object is returned while the same send holds the lock.
 */
export function libraryHoldOf(
  key: string,
): Pick<LibraryHold, "nonce" | "owner" | "end"> | undefined {
  return libraryHolds.get(key);
}

/**
 * Tells whether any library send holds a lock, on any connection.
 *
 * @returns Whether one does.
 */
export function libraryHoldsActive(): boolean {
  return libraryHolds.size > 0;
}

/**
 * Ends the hold of the library send whose raw transaction was just broadcast.
 *
 * @param key - The lock key.
 * @param failed - Whether the broadcast failed, so viem's `reset` for it is still to come.
 */
export function endLibraryHold(key: string, failed: boolean): void {
  const hold = libraryHolds.get(key);
  if (failed && hold !== undefined) {
    expectLibraryReset(key, hold.owner);
  }
  hold?.end();
}

/**
 * Counts a viem `reset` still to come for a library send that holds nothing, so that it does not
 * end another send's hold.
 *
 * @param key - The lock key.
 * @param owner - The send state of the connection that gave the hold.
 */
export function expectLibraryReset(key: string, owner: ConnectionSends): void {
  const owed = pendingResets.get(owner) ?? new Map<string, number>();
  owed.set(key, (owed.get(key) ?? 0) + 1);
  pendingResets.set(owner, owed);
}

/**
 * Uses up one viem `reset` owed by a library send that no longer holds the lock (its broadcast
 * failed), so that it ends no other send's hold.
 *
 * @param key - The lock key.
 * @param owner - The send state of the connection the reset came through.
 * @returns Whether a reset was owed.
 */
export function takeOwedLibraryReset(key: string, owner: ConnectionSends): boolean {
  const byKey = pendingResets.get(owner);
  if (byKey === undefined) {
    return false;
  }
  // A count is deleted when it reaches 0, so a stored count is at least 1.
  const owed = byKey.get(key);
  if (owed === undefined) {
    return false;
  }
  if (owed === 1) {
    byKey.delete(key);
  } else {
    byKey.set(key, owed - 1);
  }
  return true;
}

/**
 * Ends the library holds a connection's send state gave, when the connection closes.
 *
 * @param owner - The connection's send state.
 */
export function endLibraryHoldsOf(owner: ConnectionSends): void {
  for (const hold of libraryHolds.values()) {
    if (hold.owner === owner) {
      hold.end();
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
  // Stryker disable next-line EqualityOperator: Object.entries never yields two equal keys
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

/** A nonce handed out to a library account's client, not yet known to the node. */
interface Reservation {
  /** When it stops counting, in the clock of {@link ConnectionSendsOptions.now}. */
  expiresAt: number;
  /** Whether the account has signed a transaction with this nonce. */
  signed: boolean;
  /** Whether its raw transaction went to the node and was not taken. */
  failed: boolean;
  /** Whether a library send held this nonce until the hold's time limit made it a reservation. */
  afterHoldLimit: boolean;
  /**
   * Whether a viem `reset` that matched several reservations, and is still owed, may have been
   * this send's ({@link ConnectionSends.resetReservation}).
   */
  owedCandidate: boolean;
}

/** The viem resets of a sender that released no reservation yet, since each matched several. */
interface OwedResets {
  /** How many. */
  count: number;
  /** The lock key, to name the account and the chain in warnings. */
  key: string;
}

/**
 * Tells whether a reservation may be the one an owed reset is for: it was live when the reset
 * came, and its send has neither signed nor failed since. A send that signs or fails after the
 * reset was still running, so the reset was another send's.
 */
function owedCandidate(reservation: Reservation): boolean {
  return reservation.owedCandidate && !reservation.failed;
}

interface RetryEntry {
  transaction: SentTransaction;
  cancel: () => void;
}

/**
 * Asks the node whether it has a transaction: `true` when it has, `false` when it has not, and
 * `undefined` when the lookup failed.
 */
export type LookUpTransaction = (hash: string) => Promise<boolean | undefined>;

/**
 * The transactions the node accepted from a sender at one nonce, recorded with the high-water
 * mark off. A nonce can have several: a replacement with the caller's nonce, or a send after the
 * node lost the first one. A revert can bring back any of them.
 */
interface SentRecord {
  /** Every hash recorded at this nonce, to look them up after the pending count falls. */
  readonly hashes: string[];
  /** The hash recorded last. */
  newest: string;
  /** Whether it was recorded or looked up since the last fall of the pending count. */
  fresh: boolean;
  /** Whether the last lookup found the node without any of them. Such a record is looked up again before its nonce is taken. */
  gone: boolean;
}

/** A sender's sent transactions and what the nonce choice saw of its pending count. */
interface SentRecords {
  /** By nonce, with at most {@link MAX_SENT_RECORDS} hashes in all. */
  readonly byNonce: Map<bigint, SentRecord>;
  /** How many hashes `byNonce` holds. */
  hashes: number;
  /** The nonce recorded last; -1n when none was. */
  latest: bigint;
  /** The pending count of the last nonce choice for a send; -1n before the first. */
  observed: bigint;
  /** Whether a fall was seen and the node may still hold a nonce above the pending count. */
  afterFall: boolean;
  /** One above the highest nonce whose record was dropped to stay within the limit; 0n when none was. */
  droppedBelow: bigint;
}

/** What the send state of a connection needs. */
export interface ConnectionSendsOptions {
  /** Whether to keep a nonce high-water mark; off on `edr-simulated` networks. */
  highWater: boolean;
  /** Timer functions for the retry entries' lifetime. */
  timers?: Timers;
  /** The clock of the nonce reservations, in milliseconds; `Date.now` by default. */
  now?: () => number;
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
  /**
   * By sender, then by hash, oldest first: the transactions whose broadcast had no answer, still
   * to be looked up. Every one is kept, at any nonce (#506): the node may have any of them.
   */
  readonly #uncertain = new Map<string, Map<string, SentTransaction>>();
  /** By sender, in the order they were handed out: the nonces reserved for library accounts. */
  readonly #reservations = new Map<string, Map<bigint, Reservation>>();
  /** By sender: the viem resets that have released no reservation yet. */
  readonly #owedResets = new Map<string, OwedResets>();
  /**
   * By sender: the nonces of transactions that a provider may still sign after the plugin gave up
   * on them (#537). Nonce choice skips them until a transaction with the nonce reaches the node
   * through this connection ({@link recordSent}) or the connection closes. No time limit and no
   * reset ends them: the plugin cannot see whether the provider signed.
   */
  readonly #outstanding = new Map<string, Set<bigint>>();
  /**
   * By sender, with the high-water mark off: the transactions the node accepted, by nonce. A live
   * reservation leaves a gap, and the pending count stops at it, so the nonce choice counts the
   * ones at or above the pending count while the sender has a live reservation. The ones below it
   * are kept too: after the pending count falls, the node may hold any of them again (a revert
   * restores a queued transaction), and their hashes say which.
   */
  readonly #sent = new Map<string, SentRecords>();
  readonly #now: () => number;
  #closed = false;

  /**
   * @param options - Whether the high-water mark is on, and the timers.
   */
  public constructor(options: ConnectionSendsOptions) {
    this.#highWaterEnabled = options.highWater;
    this.#timers = options.timers ?? systemTimers;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Reads the nonce a send whose caller gave none would take, without asking the node anything:
   * `max(pending, highWater + 1, highest reservation + 1)`, so a node that lags on its pending
   * count does not get a nonce that was already used, and a send never takes a nonce a library
   * account's client was handed. With the mark off and a live reservation, the nonces the node
   * accepted at or above the pending count count too. After the pending count fell, it is the
   * lowest nonce at or above the pending count that no live reservation and no recorded
   * transaction uses ({@link chooseNonce}); with no lookup, every record counts as held.
   *
   * @param from - The sender's lowercase address.
   * @param pending - The node's pending transaction count for the sender.
   * @returns The nonce.
   */
  public nonceFor(from: string, pending: bigint): bigint {
    let nonce = pending;
    // -1n: no mark yet. recordSent keeps none when the mark is off.
    const mark = this.#highWater.get(from) ?? -1n;
    if (mark >= nonce) {
      nonce = mark + 1n;
    }
    const skipped = this.#skipped(from);
    // Without a reservation or an outstanding nonce there is no gap, and the pending count covers
    // every sent nonce.
    if (skipped.size === 0) {
      return nonce;
    }
    return this.#pick(from, nonce, skipped, false);
  }

  /**
   * The nonces a send skips: the sender's live reservations, and the nonces a provider may still
   * sign (#537). Either can leave a gap that the node's pending count stops at.
   */
  #skipped(from: string): Set<bigint> {
    return new Set([...this.#live(from).keys(), ...(this.#outstanding.get(from) ?? [])]);
  }

  /**
   * Chooses the nonce of a send whose caller gave none, under the sender's send lock: as
   * {@link nonceFor}, after asking the node about the transactions it may no longer have. With the
   * high-water mark on, it is {@link nonceFor}.
   *
   * With the mark off, the pending count has fallen when it is below the one the last choice saw,
   * when a transaction recorded since the last fall has the pending count's nonce, or, while a
   * reservation lives, when the node no longer has the transaction recorded last. A record made before the last fall is
   * looked up before it counts, and a record the node did not have is looked up again before its
   * nonce is taken, since a revert can bring it back. A failed lookup counts as held: a gap is
   * acceptable, signing a nonce the node still holds is not. Without a live reservation it asks
   * nothing and returns the pending count.
   *
   * @param from - The sender's lowercase address.
   * @param pending - The node's pending transaction count for the sender.
   * @param lookUp - Asks the node whether it has a transaction.
   * @returns The nonce to sign.
   */
  public async chooseNonce(
    from: string,
    pending: bigint,
    lookUp: LookUpTransaction,
  ): Promise<bigint> {
    if (this.#highWaterEnabled) {
      return this.nonceFor(from, pending);
    }
    const records = this.#recordsOf(from);
    const { byNonce } = records;
    // The node has no transaction with the pending count's nonce, so a fresh record of it fell.
    const atPending = byNonce.get(pending);
    let fell = pending < records.observed || (atPending?.fresh === true && !atPending.gone);
    records.observed = pending;
    const latest = byNonce.get(records.latest);
    if (!fell && latest?.fresh === true && !latest.gone && this.#skipped(from).size > 0) {
      fell = (await lookUp(latest.newest)) === false;
    }
    if (fell) {
      records.afterFall = true;
      for (const record of byNonce.values()) {
        record.fresh = false;
      }
    }
    if (this.#skipped(from).size === 0) {
      return this.#noReservation(records, pending);
    }
    const checked = new Set<bigint>();
    for (const [nonce, record] of byNonce) {
      if (nonce > pending && !record.fresh) {
        await this.#check(record, lookUp);
        checked.add(nonce);
      }
    }
    for (;;) {
      const nonce = this.#pick(from, pending, this.#skipped(from), true);
      const record = byNonce.get(nonce);
      if (record?.gone !== true || checked.has(nonce)) {
        return nonce;
      }
      // Gone at an earlier lookup: a revert since may have brought it back.
      await this.#check(record, lookUp);
      checked.add(nonce);
    }
  }

  /**
   * Looks a record's hashes up, and notes whether the node has none of them. One the node has, or
   * whose lookup fails, makes the nonce held.
   */
  async #check(record: SentRecord, lookUp: LookUpTransaction): Promise<void> {
    let gone = true;
    for (const hash of record.hashes) {
      if ((await lookUp(hash)) !== false) {
        gone = false;
        break;
      }
    }
    record.fresh = true;
    record.gone = gone;
  }

  /**
   * The nonce with no live reservation: the pending count. A fall stops counting once no record
   * above the pending count may be held.
   */
  #noReservation(records: SentRecords, pending: bigint): bigint {
    records.afterFall &&= [...records.byNonce].some(
      ([nonce, record]) => nonce > pending && !record.gone,
    );
    return pending;
  }

  /**
   * The nonce for a sender with live reservations. Before a fall, or with the mark on: past every
   * live reservation and every record at or above the pending count that counts as held. After a
   * fall: the lowest nonce at or above the pending count that no live reservation uses, that no
   * held record uses and, above the pending count, whose record was not dropped to stay within
   * the limit. The pending count itself the node does not have. A record counts as held when
   * `checked` is false, and otherwise unless its last lookup found it gone.
   */
  #pick(from: string, start: bigint, live: ReadonlySet<bigint>, checked: boolean): bigint {
    const records = this.#sent.get(from);
    const held = (record: SentRecord): boolean => !checked || !record.gone;
    if (records === undefined || !(records.afterFall || start < records.observed)) {
      const used = [...live];
      if (records !== undefined) {
        for (const [nonce, record] of records.byNonce) {
          if (held(record)) {
            used.push(nonce);
          }
        }
      }
      // max(start, highest used + 1): one below the start, or below a reservation, changes nothing.
      let nonce = start;
      for (const other of used) {
        if (other >= nonce) {
          nonce = other + 1n;
        }
      }
      return nonce;
    }
    for (let nonce = start; ; nonce++) {
      if (live.has(nonce)) {
        continue;
      }
      const record = records.byNonce.get(nonce);
      if (
        nonce === start ||
        (record === undefined ? nonce >= records.droppedBelow : !held(record))
      ) {
        return nonce;
      }
    }
  }

  /**
   * Reserves a nonce handed out to a library account's client, which signs and sends it itself.
   * It counts in {@link nonceFor} until its raw transaction reaches the node, the client's `reset`
   * releases it, or {@link RESERVATION_MS} pass. Nothing waits for it.
   *
   * @param from - The sender's lowercase address.
   * @param nonce - The nonce.
   * @param afterHoldLimit - Whether a library send held this nonce until its time limit.
   */
  public reserve(from: string, nonce: bigint, afterHoldLimit = false): void {
    if (this.#closed) {
      return;
    }
    const reservations = this.#live(from);
    // Deleted first, so a nonce handed out again counts as the newest.
    reservations.delete(nonce);
    reservations.set(nonce, {
      expiresAt: this.#now() + RESERVATION_MS,
      signed: false,
      failed: false,
      afterHoldLimit,
      owedCandidate: false,
    });
    this.#reservations.set(from, reservations);
  }

  /**
   * Keeps a nonce held whose transaction a provider may still sign after the plugin gave up on it
   * (#537): every nonce choice for the sender skips it, a gap rather than a second valid
   * transaction at the nonce. The hold ends when a transaction with the nonce reaches the node
   * through this connection ({@link recordSent}), or when the connection closes.
   *
   * @param from - The sender's lowercase address.
   * @param nonce - The nonce.
   */
  public holdOutstanding(from: string, nonce: bigint): void {
    if (this.#closed) {
      return;
    }
    const held = this.#outstanding.get(from) ?? new Set<bigint>();
    held.add(nonce);
    this.#outstanding.set(from, held);
  }

  /**
   * The sender's outstanding nonces, lowest first. Tests use it.
   *
   * @param from - The sender's lowercase address.
   * @returns The nonces a provider may still sign.
   */
  public outstandingNonces(from: string): bigint[] {
    return [...(this.#outstanding.get(from) ?? [])].toSorted((a, b) => (a < b ? -1 : 1));
  }

  /**
   * Notes that the account signed a transaction with a reserved nonce.
   *
   * @param from - The sender's lowercase address.
   * @param nonce - The transaction's nonce.
   */
  public signedReservation(from: string, nonce: bigint): void {
    const reservation = this.#live(from).get(nonce);
    if (reservation !== undefined) {
      // A send that signs after a reset was still running then, so the reset was not its.
      reservation.owedCandidate &&= reservation.signed;
      reservation.signed = true;
      this.#settleOwedResets(from);
    }
  }

  /**
   * Notes that the raw transaction with a reserved nonce went to the node and was not taken, so
   * the client's `reset` that follows its error releases this one.
   *
   * @param from - The sender's lowercase address.
   * @param nonce - The transaction's nonce.
   */
  public failReservation(from: string, nonce: bigint): void {
    const reservation = this.#live(from).get(nonce);
    if (reservation !== undefined) {
      reservation.failed = true;
      this.#settleOwedResets(from);
    }
  }

  /**
   * Ends the reservation of a nonce whose raw transaction the node has.
   *
   * @param from - The sender's lowercase address.
   * @param nonce - The transaction's nonce.
   */
  public releaseReservation(from: string, nonce: bigint): void {
    this.#reservations.get(from)?.delete(nonce);
    this.#settleOwedResets(from);
  }

  /**
   * Tells whether the sender has reservations that still count.
   *
   * @param from - The sender's lowercase address.
   * @returns Whether it has.
   */
  public hasReservations(from: string): boolean {
    return this.#live(from).size > 0;
  }

  /**
   * Ends the reservations of nonces up to one that a send through the plugin used. A reservation
   * that a library send's hold left at its time limit ends only when the send used its very nonce:
   * a higher nonce says nothing about whether that library send went out, and its `reset` must
   * still find it, to warn about the gap it leaves. The plugin's send says nothing about the
   * library sends either, so an owed reset may have been an ended one's; one owed reset counts as
   * settled per ended candidate.
   *
   * @param from - The sender's lowercase address.
   * @param nonce - The send's nonce.
   */
  public releaseReservationsUpTo(from: string, nonce: bigint): void {
    const reservations = this.#reservations.get(from) ?? new Map<bigint, Reservation>();
    let candidates = 0;
    for (const [reserved, reservation] of reservations) {
      if (reservation.afterHoldLimit ? reserved === nonce : reserved <= nonce) {
        reservations.delete(reserved);
        candidates += owedCandidate(reservation) ? 1 : 0;
      }
    }
    this.#settleOwedResetsOf(from, candidates);
  }

  /**
   * Handles a client's failed send (viem's `nonceManager.reset`), which does not say which nonce.
   * With a reservation whose raw transaction failed, the newest such one ends. Otherwise the reset
   * is owed to one of the reservations, signed or not: viem resets after a failed estimate and
   * after a broadcast that timed out alike. A reset with a single candidate ends it at once, and
   * one with several ends none, since ending the wrong one would let a send through the plugin
   * take a nonce that a running send still has. An owed reset is settled when the candidates left
   * are no more than the owed resets: they all failed, so they all end. Candidates leave when
   * their send signs, fails or broadcasts through the connection (it was still running), or when
   * they end with no such sign: a caller's nonce at or above theirs, or their time is up, which a
   * warning reports.
   *
   * When an ended reservation was left by a library send's hold at its time limit, and the sender
   * has used a higher nonce since (the high-water mark, another reservation, or the nonce of a
   * hold this connection gave is above it), a warning says that its nonce may be a gap.
   *
   * @param key - The lock key, `chainId:address` with the sender's lowercase address.
   */
  public resetReservation(key: string): void {
    const from = key.slice(key.indexOf(":") + 1);
    const live = this.#live(from);
    const entries = [...live].toReversed();
    const failed = entries.find(([, reservation]) => reservation.failed);
    if (failed !== undefined) {
      live.delete(failed[0]);
      this.#warnAboutGaps(key, from, [failed]);
      return;
    }
    // With no reservation, the settlement below drops the owed reset at once.
    for (const [, reservation] of entries) {
      reservation.owedCandidate = true;
    }
    const owed = this.#owedResets.get(from) ?? { count: 0, key };
    owed.count++;
    this.#owedResets.set(from, owed);
    this.#settleOwedResets(from);
  }

  /**
   * Ends the candidates of the sender's owed resets when there are no more of them than owed
   * resets: each owed reset is a distinct send's, and a candidate is the only place its send can
   * be, so every candidate left failed.
   */
  #settleOwedResets(from: string): void {
    const owed = this.#owedResets.get(from);
    if (owed === undefined) {
      return;
    }
    const live = this.#live(from);
    const candidates = [...live].filter(([, reservation]) => owedCandidate(reservation));
    if (candidates.length > owed.count) {
      return;
    }
    this.#owedResets.delete(from);
    for (const [nonce] of candidates) {
      live.delete(nonce);
    }
    this.#warnAboutGaps(owed.key, from, candidates);
  }

  /**
   * Warns about an ended reservation below an accepted nonce, or a reservation left by an
   * expired hold below another nonce the sender has used.
   */
  #warnAboutGaps(
    key: string,
    from: string,
    ended: readonly (readonly [bigint, Reservation])[],
  ): void {
    const current = libraryHolds.get(key);
    // -1n: no mark, or no hold of this connection. The ended reservations are no longer live.
    const accepted = [this.#highWater.get(from) ?? -1n];
    const sent = this.#sent.get(from);
    if (sent !== undefined) {
      for (const [nonce, record] of sent.byNonce) {
        if (!record.gone) {
          accepted.push(nonce);
        }
      }
    }
    const used = [
      ...accepted,
      current?.owner === this ? current.nonce : -1n,
      ...this.#live(from).keys(),
    ];
    for (const [nonce, reservation] of ended) {
      if (reservation.afterHoldLimit && used.some((other) => other > nonce)) {
        warnAboutNonceGap(key, nonce);
      } else if (accepted.some((other) => other > nonce)) {
        warnAboutReservationGap(key, nonce);
      }
    }
  }

  /** The sender's sent records, created empty when it has none. */
  #recordsOf(from: string): SentRecords {
    let records = this.#sent.get(from);
    if (records === undefined) {
      records = {
        byNonce: new Map(),
        hashes: 0,
        latest: -1n,
        observed: -1n,
        afterFall: false,
        droppedBelow: 0n,
      };
      this.#sent.set(from, records);
    }
    return records;
  }

  /**
   * The sender's reservations that still count. Expired ones are dropped, and when an owed reset
   * may have been for one of them, a warning names their nonces and the reset is settled.
   */
  #live(from: string): Map<bigint, Reservation> {
    const reservations = this.#reservations.get(from) ?? new Map<bigint, Reservation>();
    const now = this.#now();
    const expired: bigint[] = [];
    for (const [nonce, reservation] of reservations) {
      if (reservation.expiresAt <= now) {
        reservations.delete(nonce);
        if (owedCandidate(reservation)) {
          expired.push(nonce);
        }
      }
    }
    const owed = this.#owedResets.get(from);
    if (owed !== undefined && expired.length > 0) {
      warnAboutOwedReset(owed.key, expired);
      this.#settleOwedResetsOf(from, expired.length);
    }
    return reservations;
  }

  /**
   * Counts owed resets as settled, one per candidate that ended with no sign that its send still
   * ran: the reset may have been its. This keeps the candidates left reserved, since a settled
   * reset never ends a reservation.
   */
  #settleOwedResetsOf(from: string, ended: number): void {
    const owed = this.#owedResets.get(from);
    if (owed !== undefined) {
      owed.count -= ended;
      if (owed.count <= 0) {
        this.#owedResets.delete(from);
      }
    }
  }

  /**
   * Returns the sender's high-water mark.
   *
   * @param from - The sender's lowercase address.
   * @returns The highest nonce the node accepted on this connection, or `undefined` when there is
   * none or the mark is off.
   */
  public highWaterOf(from: string): bigint | undefined {
    return this.#highWater.get(from);
  }

  /**
   * Counts the hashes in the sender's sent records. Tests use it to check that the record stays bounded.
   *
   * @param from - The sender's lowercase address.
   * @returns How many transactions are recorded; always 0 with the high-water mark on.
   */
  public sentRecords(from: string): number {
    return this.#sent.get(from)?.hashes ?? 0;
  }

  /**
   * Records a transaction the node accepted: `highWater = max(highWater, nonce)`. With the mark
   * off, its nonce and hash, next to the hashes recorded before at that nonce; beyond
   * {@link MAX_SENT_RECORDS} hashes, the nonce recorded first is dropped with all its hashes, and after a fall
   * {@link chooseNonce} takes no nonce above the pending count up to the highest dropped one.
   * It ends the hold of an outstanding nonce ({@link holdOutstanding}) at this nonce.
   *
   * @param from - The sender's lowercase address.
   * @param nonce - The nonce of the accepted transaction.
   * @param hash - Its hash.
   */
  public recordSent(from: string, nonce: bigint, hash: string): void {
    // The node has a transaction at the nonce, so no second one can take it: the hold ends here,
    // and the record below keeps the nonce used as for any send.
    const outstanding = this.#outstanding.get(from);
    if (outstanding?.delete(nonce) === true && outstanding.size === 0) {
      this.#outstanding.delete(from);
    }
    if (!this.#highWaterEnabled) {
      const records = this.#recordsOf(from);
      const { byNonce } = records;
      const record = byNonce.get(nonce);
      if (record === undefined) {
        byNonce.set(nonce, { hashes: [hash], newest: hash, fresh: true, gone: false });
        records.hashes++;
      } else {
        if (!record.hashes.includes(hash)) {
          record.hashes.push(hash);
          records.hashes++;
        }
        record.newest = hash;
        record.fresh = true;
        record.gone = false;
      }
      records.latest = nonce;
      // The nonce recorded first goes, with all its hashes; one recorded again keeps its place.
      for (const [oldest, dropped] of byNonce) {
        if (records.hashes <= MAX_SENT_RECORDS) {
          break;
        }
        byNonce.delete(oldest);
        records.hashes -= dropped.hashes.length;
        records.droppedBelow = max(records.droppedBelow, oldest + 1n);
      }
      return;
    }
    const mark = this.#highWater.get(from);
    if (
      mark === undefined ||
      // Stryker disable next-line EqualityOperator: >= sets the mark to the value it already has
      nonce > mark
    ) {
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
   * ask the node whether it has it. It is kept next to the sender's earlier uncertain
   * transactions, whatever their nonces, and with the caller's nonce too: a newer one never hides
   * an older one the node may have (#506). The same transaction again becomes the newest. Beyond
   * {@link MAX_UNCERTAIN_RECORDS}, the one kept first is recorded as sent ({@link recordSent})
   * without a lookup. With the high-water mark off too: the node's pending count stops at a
   * reservation's gap, so a transaction the node has past it must be recorded.
   *
   * @param from - The sender's lowercase address.
   * @param transaction - The transaction.
   */
  public rememberUncertain(from: string, transaction: SentTransaction): void {
    if (this.#closed) {
      return;
    }
    let kept = this.#uncertain.get(from);
    if (kept === undefined) {
      kept = new Map();
      this.#uncertain.set(from, kept);
    }
    // Deleted first, so it counts as the newest.
    kept.delete(transaction.hash);
    kept.set(transaction.hash, transaction);
    for (const [hash, oldest] of kept) {
      if (kept.size <= MAX_UNCERTAIN_RECORDS) {
        break;
      }
      kept.delete(hash);
      // Not looked up, so counted as the node's: a gap at worst, never a reused nonce.
      this.recordSent(from, oldest.nonce, oldest.hash);
    }
  }

  /**
   * Takes the sender's uncertain transactions. They are removed.
   *
   * @param from - The sender's lowercase address.
   * @returns The transactions, the one kept first first; empty when there is none.
   */
  public takeUncertain(from: string): SentTransaction[] {
    const kept = this.#uncertain.get(from);
    this.#uncertain.delete(from);
    return kept === undefined ? [] : [...kept.values()];
  }

  /**
   * Forgets the sender's uncertain transaction with this hash, if there is one: the node has
   * answered for it since. The others stay.
   *
   * @param from - The sender's lowercase address.
   * @param hash - The transaction hash.
   */
  public settleUncertain(from: string, hash: string): void {
    this.#uncertain.get(from)?.delete(hash);
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
    this.#sent.clear();
    this.#uncertain.clear();
    this.#reservations.clear();
    this.#outstanding.clear();
    endLibraryHoldsOf(this);
  }
}
