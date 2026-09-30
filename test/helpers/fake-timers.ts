import type { Timers } from "../../src/internal/signer/timeout.ts";

/** Manually driven timers: nothing fires until {@link FakeTimers.fire} is called. */
export interface FakeTimers extends Timers {
  /** Fires every pending timer. */
  fire(): void;
  /** Number of timers scheduled and not cancelled. */
  pending(): number;
}

/**
 * Creates timers controlled by the test instead of the clock.
 *
 * @returns The fake timers.
 */
export function fakeTimers(): FakeTimers {
  const timers = new Set<() => void>();
  return {
    setTimeout(callback) {
      timers.add(callback);
      return () => {
        timers.delete(callback);
      };
    },
    fire() {
      for (const callback of Array.from(timers)) {
        timers.delete(callback);
        callback();
      }
    },
    pending: () => timers.size,
  };
}
