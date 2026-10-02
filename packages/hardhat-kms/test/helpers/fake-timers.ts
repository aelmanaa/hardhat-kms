import type { Timers } from "../../src/internal/signer/timeout.ts";

/** Manually driven timers: nothing fires until {@link FakeTimers.fire} is called. */
export interface FakeTimers extends Timers {
  /** Fires every pending timer. */
  fire(): void;
  /** Number of timers scheduled and not cancelled. */
  pending(): number;
  /** The delays of the pending timers, in milliseconds, in the order they were scheduled. */
  delays(): number[];
}

/**
 * Creates timers controlled by the test instead of the clock.
 *
 * @returns The fake timers.
 */
export function fakeTimers(): FakeTimers {
  const timers = new Map<() => void, number>();
  return {
    setTimeout(callback, ms) {
      // Each timer gets its own entry, even when one callback is scheduled twice.
      const entry = (): void => {
        callback();
      };
      timers.set(entry, ms);
      return () => {
        timers.delete(entry);
      };
    },
    fire() {
      for (const callback of Array.from(timers.keys())) {
        // Skip a timer that an earlier callback of this round cancelled, as real timers do.
        if (timers.delete(callback)) {
          callback();
        }
      }
    },
    pending: () => timers.size,
    delays: () => Array.from(timers.values()),
  };
}
