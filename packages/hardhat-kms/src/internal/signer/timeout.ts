/** Timer functions, injectable so tests can control time. */
export interface Timers {
  /**
   * Schedules `callback` after `ms` milliseconds.
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

/**
 * Runs `operation` with a deadline.
 *
 * The operation receives an `AbortSignal` that fires on timeout; the returned promise also
 * rejects on timeout even if the operation ignores the signal.
 *
 * @param operation - The work to run.
 * @param timeoutMs - The time budget in milliseconds.
 * @param timers - Timer functions (defaults to the system timers).
 * @returns The operation's result.
 * @throws {TimeoutError} If the deadline passes first.
 */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timers: Timers = systemTimers,
): Promise<T> {
  const controller = new AbortController();
  const timedOut = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        reject(new TimeoutError(`timed out after ${timeoutMs} ms`));
      },
      { once: true },
    );
  });
  const cancel = timers.setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await Promise.race([operation(controller.signal), timedOut]);
  } finally {
    cancel();
  }
}
