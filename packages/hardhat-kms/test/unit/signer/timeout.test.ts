import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { describe, it, mock } from "node:test";

import { ERRORS } from "../../../src/internal/error-catalog.ts";
import { catalogMessage } from "../../../src/internal/errors.ts";
import {
  CancelledError,
  systemTimers,
  TimeoutError,
  untilCancelled,
  withTimeout,
} from "../../../src/internal/signer/timeout.ts";
import { fakeTimers } from "../../helpers/fake-timers.ts";

/** Asserts that `promise` rejects with the caller-cancelled error. */
async function rejectsCancelled(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CancelledError, `expected CancelledError, got ${String(error)}`);
    assert.equal(error.name, "CancelledError");
    assert.equal(error.message, catalogMessage(ERRORS.cancelled, {}));
    return true;
  });
}

/** Replaced in a promise's executor before it is called. */
const ignore = (): void => undefined;

/** A promise that never settles. */
const never = async (): Promise<never> =>
  await new Promise<never>(() => {
    // Never answers.
  });

describe("withTimeout", () => {
  it("returns the result and cancels the timer when the operation finishes in time", async () => {
    const timers = fakeTimers();

    assert.equal(await withTimeout(async () => await Promise.resolve(42), 1000, timers), 42);
    assert.equal(timers.pending(), 0);
  });

  it("rejects and aborts the signal when the deadline passes", async () => {
    const timers = fakeTimers();
    let aborted = false;
    const pending = withTimeout(
      async (signal) =>
        await new Promise<never>(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
      50,
      timers,
    );

    assert.deepEqual(timers.delays(), [50]);
    timers.fire();
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof TimeoutError);
      assert.equal(error.name, "TimeoutError");
      assert.equal(error.message, catalogMessage(ERRORS.timedOut, { timeout: 50 }));
      return true;
    });
    assert.ok(aborted);
  });

  it("passes operation errors through", async () => {
    await assert.rejects(
      withTimeout(async () => await Promise.reject(new RangeError("boom")), 1000, fakeTimers()),
      RangeError,
    );
  });

  it("uses real timers by default", async () => {
    let fired = false;
    const cancel = systemTimers.setTimeout(() => {
      fired = true;
    }, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    cancel();

    assert.ok(fired);
    assert.equal(await withTimeout(async () => await Promise.resolve("ok"), 1000), "ok");
  });

  it("cancels a system timer, so its callback never runs", () => {
    // Node's mock timers replace the global setTimeout and clearTimeout the system timers call.
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const fired: string[] = [];
      const cancel = systemTimers.setTimeout(() => {
        fired.push("cancelled");
      }, 1000);
      systemTimers.setTimeout(() => {
        fired.push("kept");
      }, 1000);
      cancel();
      mock.timers.tick(1000);

      assert.deepEqual(fired, ["kept"]);
    } finally {
      mock.timers.reset();
    }
  });

  it("does not keep the process alive with a pending timer", () => {
    const module = new URL("../../../src/internal/signer/timeout.ts", import.meta.url).href;
    const started = Date.now();
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { systemTimers } = await import(${JSON.stringify(module)}); systemTimers.setTimeout(() => {}, 60_000);`,
      ],
      { encoding: "utf8", timeout: 20_000 },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.ok(Date.now() - started < 20_000);
  });

  it("rejects and aborts the operation's signal when the caller's signal aborts", async () => {
    const timers = fakeTimers();
    const caller = new AbortController();
    let seen: AbortSignal | undefined;
    const pending = withTimeout(
      async (signal) => {
        seen = signal;
        return await never();
      },
      50,
      timers,
      caller.signal,
    );

    assert.equal(seen?.aborted, false);
    caller.abort();
    await rejectsCancelled(pending);
    assert.equal(seen.aborted, true);
    assert.ok(seen.reason instanceof CancelledError, "the operation's signal says why");
    assert.equal(timers.pending(), 0, "the deadline is cancelled");
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  });

  it("gives the operation's signal the timeout as its reason", async () => {
    const timers = fakeTimers();
    let seen: AbortSignal | undefined;
    const pending = withTimeout(
      async (signal) => {
        seen = signal;
        return await never();
      },
      50,
      timers,
    );
    timers.fire();
    await assert.rejects(pending, TimeoutError);
    assert.ok(seen?.reason instanceof TimeoutError);
  });

  it("never starts the operation when the caller's signal has already aborted", async () => {
    const timers = fakeTimers();
    let started = false;
    await rejectsCancelled(
      withTimeout(
        async () => {
          started = true;
          return await Promise.resolve(1);
        },
        50,
        timers,
        AbortSignal.abort(),
      ),
    );
    assert.equal(started, false);
    assert.equal(timers.pending(), 0, "no deadline was set");
  });

  it("drops an answer that lands in the same turn as the caller's abort", async () => {
    const caller = new AbortController();
    let resolve: (value: number) => void = ignore;
    const answer = new Promise<number>((done) => {
      resolve = done;
    });
    // Not an async function: the race then sees the answer one turn before the abort.
    const pending = withTimeout(() => answer, 50, fakeTimers(), caller.signal);
    resolve(1);
    caller.abort();
    await rejectsCancelled(pending);
  });

  it("keeps the timeout as the error when the caller aborts after it", async () => {
    const timers = fakeTimers();
    const caller = new AbortController();
    const pending = withTimeout(never, 50, timers, caller.signal);
    timers.fire();
    caller.abort();
    await assert.rejects(pending, TimeoutError);
  });

  it("keeps the caller's abort as the error when the deadline passes after it", async () => {
    const timers = fakeTimers();
    const caller = new AbortController();
    const pending = withTimeout(never, 50, timers, caller.signal);
    caller.abort();
    timers.fire();
    await rejectsCancelled(pending);
  });

  it("returns the result and stops listening to the caller's signal", async () => {
    const timers = fakeTimers();
    const caller = new AbortController();
    assert.equal(
      await withTimeout(async () => await Promise.resolve(42), 50, timers, caller.signal),
      42,
    );
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    assert.equal(timers.pending(), 0);
  });

  it("stops listening to the caller's signal when the operation fails", async () => {
    const caller = new AbortController();
    await assert.rejects(
      withTimeout(
        async () => await Promise.reject(new RangeError("boom")),
        50,
        fakeTimers(),
        caller.signal,
      ),
      RangeError,
    );
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  });
});

describe("untilCancelled", () => {
  it("returns what the promise resolves to, and stops listening to the signal", async () => {
    const caller = new AbortController();
    assert.equal(await untilCancelled(Promise.resolve("ok"), caller.signal), "ok");
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  });

  it("passes the promise's error through", async () => {
    const caller = new AbortController();
    await assert.rejects(
      untilCancelled(Promise.reject(new RangeError("boom")), caller.signal),
      RangeError,
    );
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  });

  it("stops waiting when the signal aborts, and leaves the work running", async () => {
    const caller = new AbortController();
    let resolve: (value: string) => void = ignore;
    const work = new Promise<string>((done) => {
      resolve = done;
    });
    const pending = untilCancelled(work, caller.signal);
    caller.abort();
    await rejectsCancelled(pending);
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    resolve("later");
    assert.equal(await work, "later");
  });

  it("refuses at once when the signal has already aborted", async () => {
    await rejectsCancelled(untilCancelled(never(), AbortSignal.abort()));
  });
});
