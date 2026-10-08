import { ERRORS } from "../error-catalog.ts";
import { catalogMessage } from "../errors.ts";

/** Timer functions, injectable so tests can control time. */
export interface Timers {
  /**
   * Schedules `callback` after `ms` milliseconds. It never calls `callback` before it returns, as
   * the global `setTimeout` never does; the send lock arms a waiter's limit before it queues the
   * waiter and relies on this.
   *
   * @returns A function that cancels the timer.
   */
  setTimeout(callback: () => void, ms: number): () => void;
}

/** The global timers, unref'd so a pending timeout never keeps the process alive. */
export const systemTimers: Timers = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return () => {
      clearTimeout(handle);
    };
  },
};

/** Error raised when a call exceeds its time budget. */
export class TimeoutError extends Error {
  public override readonly name = "TimeoutError";
}

/** Error raised when the caller's abort signal stops a call. */
export class CancelledError extends Error {
  public override readonly name = "CancelledError";
}

/** Replaced in a promise's executor, which runs before the function is used. */
const noop = (): void => undefined;

/** Whether a signal, if any, has aborted. A function, so each call reads the signal again. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function cancelledError(): CancelledError {
  return new CancelledError(catalogMessage(ERRORS.cancelled, {}));
}

/**
 * Runs `operation` with a deadline, and stops it when the caller's signal aborts.
 *
 * The operation receives an `AbortSignal` that fires on timeout or when `callerSignal` aborts;
 * the returned promise also rejects then, even if the operation ignores the signal. When
 * `callerSignal` has already aborted, the operation never starts. An answer that arrives after
 * `callerSignal` aborted is dropped.
 *
 * @param operation - The work to run.
 * @param timeoutMs - The time budget in milliseconds.
 * @param timers - Timer functions (defaults to the system timers).
 * @param callerSignal - The caller's signal, if any.
 * @returns The operation's result.
 * @throws {TimeoutError} If the deadline passes first.
 * @throws {CancelledError} If `callerSignal` aborts first, or had aborted before the call.
 */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timers: Timers = systemTimers,
  callerSignal?: AbortSignal,
): Promise<T> {
  if (isAborted(callerSignal)) {
    throw cancelledError();
  }
  const controller = new AbortController();
  let rejectStopped: (error: Error) => void = noop;
  const stopped = new Promise<never>((_, reject) => {
    rejectStopped = reject;
  });
  // The first of the deadline and the caller's abort decides the error: a promise settles once,
  // and a signal aborts once.
  const stop = (error: Error): void => {
    rejectStopped(error);
    controller.abort(error);
  };
  const onCallerAbort = (): void => {
    stop(cancelledError());
  };
  callerSignal?.addEventListener("abort", onCallerAbort);
  const cancel = timers.setTimeout(() => {
    stop(new TimeoutError(catalogMessage(ERRORS.timedOut, { timeout: timeoutMs })));
  }, timeoutMs);
  try {
    const result = await Promise.race([operation(controller.signal), stopped]);
    // The answer and the abort can land in the same turn: the abort wins.
    if (isAborted(callerSignal)) {
      throw cancelledError();
    }
    return result;
  } finally {
    cancel();
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * Waits for `promise`, or stops waiting when `signal` aborts. The work behind `promise` goes on;
 * use it for work that other callers share, which one caller's abort must not stop.
 *
 * @param promise - What to wait for.
 * @param signal - The caller's signal.
 * @returns What `promise` resolves to.
 * @throws {CancelledError} If `signal` aborts first, or had aborted before the call.
 */
export async function untilCancelled<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw cancelledError();
  }
  let onAbort: () => void = noop;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(cancelledError());
    };
  });
  signal.addEventListener("abort", onAbort);
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
