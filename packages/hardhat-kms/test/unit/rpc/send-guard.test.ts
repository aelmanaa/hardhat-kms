import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it, mock } from "node:test";

import { HardhatPluginError } from "hardhat/plugins";

import { PLUGIN_ID } from "../../../src/internal/constants.ts";
import {
  canonicalJson,
  ConnectionSends,
  describeSendKey,
  MAX_RETRY_ENTRIES,
  endLibraryHold,
  endLibraryHoldsOf,
  expectLibraryReset,
  holdForLibrary,
  LIBRARY_HOLD_MS,
  LIBRARY_WAIT_WARNING_MS,
  libraryHoldOf,
  libraryHoldsActive,
  MAX_SEND_LOCK_WAITERS,
  RESERVATION_MS,
  takeOwedLibraryReset,
  RETRY_TTL_MS,
  SEND_LOCK_STALL_MS,
  sendLocksInUse,
  withSendLock,
} from "../../../src/internal/rpc/send-guard.ts";
import { CancelledError, systemTimers, type Timers } from "../../../src/internal/signer/timeout.ts";
import { fakeTimers } from "../../helpers/fake-timers.ts";

/** A promise and the function that resolves it. */
function gate(): { promise: Promise<void>; open: () => void } {
  const control: { open: () => void } = { open: () => {} };
  const promise = new Promise<void>((resolve) => {
    control.open = resolve;
  });
  return { promise, open: () => control.open() };
}

/** Lets pending promise callbacks run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Timers driven by a fake clock: {@link ClockTimers.advance} fires what falls due, in order. */
interface ClockTimers extends Timers {
  /** Moves the clock forward by `ms`, firing each due timer and letting its callbacks run. */
  advance(ms: number): Promise<void>;
  /** Number of timers scheduled and not cancelled. */
  pending(): number;
}

/**
 * Creates timers on a fake clock that starts at 0.
 *
 * @returns The timers.
 */
function clockTimers(): ClockTimers {
  let now = 0;
  const timers = new Set<{ at: number; callback: () => void }>();
  return {
    setTimeout(callback, ms) {
      const timer = { at: now + ms, callback };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers]
          .filter((timer) => timer.at <= end)
          .toSorted((a, b) => a.at - b.at)[0];
        if (due === undefined) {
          break;
        }
        timers.delete(due);
        now = due.at;
        due.callback();
        await settle();
      }
      now = end;
      await settle();
    },
    pending: () => timers.size,
  };
}

/**
 * Records how a promise settles, without awaiting it.
 *
 * @param promise - The promise.
 * @returns An object whose `error` and `done` fields fill in when the promise settles.
 */
function watch(promise: Promise<unknown>): { error?: unknown; done: boolean } {
  const state: { error?: unknown; done: boolean } = { done: false };
  promise.then(
    () => {
      state.done = true;
      return undefined;
    },
    (error: unknown) => {
      state.error = error;
      state.done = true;
    },
  );
  return state;
}

// Each test below uses its own address, so a failed test leaves no lock that a later one waits on.
/**
 * Checks that an error is the plugin's own error, from this plugin.
 *
 * @param error - The error.
 */
function assertPluginError(error: unknown): void {
  assert.ok(error instanceof HardhatPluginError);
  assert.equal(error.pluginId, PLUGIN_ID);
}

const REENTRANT = (address: string): RegExp =>
  new RegExp(`${address} on chain 1 was made from inside an earlier send .* not signed or sent`);
const STALLED = (address: string): RegExp =>
  new RegExp(`${address} on chain 1 waited 120 s .* not signed or sent`);
const QUEUE_FULL = (address: string): RegExp =>
  new RegExp(
    `Too many sends from ${address} on chain 1 are waiting: the limit is 1024\\. .* not signed or sent`,
  );

describe("describeSendKey", () => {
  it("names the account and the chain of a lock key, and returns a key without a colon as is", () => {
    assert.equal(describeSendKey("1:0xab"), "0xab on chain 1");
    assert.equal(describeSendKey("0xab"), "0xab");
  });
});

describe("withSendLock", () => {
  it("runs holders of one key one after the other, in order", async () => {
    const order: string[] = [];
    const first = gate();
    const a = withSendLock("1:0xa", async () => {
      order.push("a start");
      await first.promise;
      order.push("a end");
    });
    const b = withSendLock("1:0xa", async () => {
      order.push("b");
      await Promise.resolve();
    });
    await settle();
    assert.deepEqual(order, ["a start"], "b waits for a");
    first.open();
    await Promise.all([a, b]);
    assert.deepEqual(order, ["a start", "a end", "b"]);
    assert.equal(sendLocksInUse(), 0);
  });

  it("does not make other keys wait", async () => {
    const held = gate();
    const a = withSendLock("1:0xa", async () => await held.promise);
    assert.equal(await withSendLock("1:0xb", async () => await Promise.resolve("b")), "b");
    assert.equal(
      await withSendLock("2:0xa", async () => await Promise.resolve("other chain")),
      "other chain",
    );
    held.open();
    await a;
    assert.equal(sendLocksInUse(), 0);
  });

  it("releases the lock when the holder fails", async () => {
    await assert.rejects(
      withSendLock("1:0xa", async () => {
        await Promise.resolve();
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(await withSendLock("1:0xa", async () => await Promise.resolve(1)), 1);
    assert.equal(sendLocksInUse(), 0);
  });
});

describe("withSendLock re-entrancy", () => {
  it("fails a send for the key its own context holds within one tick, and the holder completes", async () => {
    let inner: { error?: unknown; done: boolean } | undefined;
    const outer = await withSendLock("1:0xa1", async () => {
      inner = watch(withSendLock("1:0xa1", async () => await Promise.resolve("inner")));
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(inner.done, true, "the re-entrant send settled within one tick");
      return "outer";
    });
    assert.equal(outer, "outer");
    assert.match(String(inner?.error), REENTRANT("0xa1"));
    assertPluginError(inner?.error);
    assert.equal(sendLocksInUse(), 0);
  });

  it("still sees the hold after an await and inside a timer", async () => {
    const errors: unknown[] = [];
    await withSendLock("1:0xa2", async () => {
      await settle();
      await withSendLock("1:0xa2", async () => await Promise.resolve()).catch((error: unknown) => {
        errors.push(error);
      });
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          withSendLock("1:0xa2", async () => await Promise.resolve())
            .catch((error: unknown) => {
              errors.push(error);
            })
            .finally(resolve);
        }, 0);
      });
    });
    assert.equal(errors.length, 2);
    for (const error of errors) {
      assert.match(String(error), REENTRANT("0xa2"));
    }
    assert.equal(sendLocksInUse(), 0);
  });

  it("lets a holder send for another key, and for the same account on another chain", async () => {
    const results = await withSendLock("1:0xa3", async () => [
      await withSendLock("1:0xb", async () => await Promise.resolve("other account")),
      await withSendLock("2:0xa3", async () => await Promise.resolve("other chain")),
      await withSendLock(
        "1:0xb",
        async () =>
          // A nested holder of 1:0xb still holds 1:0xa through its parent.
          await withSendLock("1:0xa3", async () => await Promise.resolve("never")).catch(
            (error: unknown) => (REENTRANT("0xa3").test(String(error)) ? "refused" : "wrong"),
          ),
      ),
    ]);
    assert.deepEqual(results, ["other account", "other chain", "refused"]);
    assert.equal(sendLocksInUse(), 0);
  });

  it("queues work that a holder started but did not wait for, once the hold is released", async () => {
    const release = gate();
    let later: Promise<string> | undefined;
    await withSendLock("1:0xa4", async () => {
      later = (async () => {
        await release.promise;
        return await withSendLock("1:0xa4", async () => await Promise.resolve("later"));
      })();
      await Promise.resolve();
    });
    release.open();
    assert.equal(await later, "later");
    assert.equal(sendLocksInUse(), 0);
  });
});

describe("withSendLock limits", () => {
  it(`fails a waiter after ${SEND_LOCK_STALL_MS} ms without progress, and frees the lock after`, async () => {
    const timers = clockTimers();
    const held = gate();
    const holder = withSendLock("1:0xa5", async () => await held.promise, timers);
    let ran = false;
    const waiter = watch(
      withSendLock(
        "1:0xa5",
        async () => {
          ran = true;
          await Promise.resolve();
        },
        timers,
      ),
    );
    await timers.advance(SEND_LOCK_STALL_MS - 1);
    assert.equal(waiter.done, false, "not before the limit");
    await timers.advance(1);
    assert.equal(waiter.done, true);
    assert.match(String(waiter.error), STALLED("0xa5"));
    assertPluginError(waiter.error);
    assert.equal(ran, false, "the waiter's work never ran");
    held.open();
    await holder;
    assert.equal(sendLocksInUse(), 0);
    assert.equal(timers.pending(), 0);
  });

  it("counts each waiter's limit from when it joined or the queue last moved", async () => {
    const timers = clockTimers();
    const held = gate();
    const order: string[] = [];
    const holder = withSendLock("1:0xa6", async () => await held.promise, timers);
    const first = watch(withSendLock("1:0xa6", async () => await Promise.resolve(), timers));
    await timers.advance(60_000);
    const second = withSendLock(
      "1:0xa6",
      async () => {
        order.push("second");
        await Promise.resolve();
      },
      timers,
    );
    await timers.advance(60_000);
    assert.match(String(first.error), STALLED("0xa6"));
    held.open();
    await Promise.all([holder, second]);
    assert.deepEqual(order, ["second"]);
    assert.equal(sendLocksInUse(), 0);
    assert.equal(timers.pending(), 0);
  });

  it("runs both waiters in order when the holder throws", async () => {
    const timers = clockTimers();
    const held = gate();
    const order: string[] = [];
    const holder = withSendLock(
      "1:0xb1",
      async () => {
        await held.promise;
        throw new Error("boom");
      },
      timers,
    );
    const waiters = ["first", "second"].map(
      async (name) =>
        await withSendLock(
          "1:0xb1",
          async () => {
            order.push(name);
            await Promise.resolve();
          },
          timers,
        ),
    );
    held.open();
    await assert.rejects(holder, /boom/);
    await Promise.all(waiters);
    assert.deepEqual(order, ["first", "second"]);
    assert.equal(sendLocksInUse(), 0);
    assert.equal(timers.pending(), 0);
  });

  it("keeps the order of the others when only a waiter in the middle times out", async () => {
    // Timers fired one by one, so that only B's limit runs out.
    const scheduled: { callback: () => void; live: boolean }[] = [];
    const timers: Timers = {
      setTimeout(callback) {
        const timer = { callback, live: true };
        scheduled.push(timer);
        return () => {
          timer.live = false;
        };
      },
    };
    const held = gate();
    const order: string[] = [];
    const send = async (name: string): Promise<void> => {
      await withSendLock(
        "1:0xb2",
        async () => {
          order.push(name);
          await Promise.resolve();
        },
        timers,
      );
    };
    const holder = withSendLock("1:0xb2", async () => await held.promise, timers);
    const a = send("a");
    const b = watch(send("b"));
    const c = send("c");
    await settle();
    // Per waiter, in order: its warning timer (LIBRARY_WAIT_WARNING_MS), then its limit.
    assert.equal(scheduled.length, 6, "one warning timer and one limit per waiter");
    const limitOfB = scheduled[3];
    assert.ok(limitOfB !== undefined);
    limitOfB.live = false;
    limitOfB.callback();
    await settle();
    assert.match(String(b.error), STALLED("0xb2"));
    held.open();
    await Promise.all([holder, a, c]);
    assert.deepEqual(order, ["a", "c"]);
    assert.equal(sendLocksInUse(), 0);
    assert.equal(
      scheduled.filter((timer) => timer.live).length,
      0,
      "every limit was cancelled or fired",
    );
  });

  it("ignores the limit of a waiter that already has the lock", async () => {
    // Timers that cannot be cancelled, like a limit that fires while the lock is handed over.
    const callbacks: (() => void)[] = [];
    const timers: Timers = {
      setTimeout(callback) {
        callbacks.push(callback);
        return () => {};
      },
    };
    const held = gate();
    const second = gate();
    const order: string[] = [];
    const holder = withSendLock("1:0xb3", async () => await held.promise, timers);
    const b = withSendLock(
      "1:0xb3",
      async () => {
        order.push("b");
        await second.promise;
      },
      timers,
    );
    const c = watch(
      withSendLock(
        "1:0xb3",
        async () => {
          order.push("c");
          await Promise.resolve();
        },
        timers,
      ),
    );
    await settle();
    // In order: b's warning timer and limit, then c's.
    const limitOfB = callbacks[1];
    assert.ok(limitOfB !== undefined);
    held.open();
    await holder;
    await settle();
    assert.deepEqual(order, ["b"]);
    limitOfB();
    second.open();
    await b;
    await settle();
    assert.deepEqual(order, ["b", "c"], "c keeps its place in the queue");
    assert.equal(c.done, true);
    assert.equal(c.error, undefined);
    assert.equal(sendLocksInUse(), 0);
  });

  it("fails a send whose timers throw, and leaves no waiter behind", async () => {
    let calls = 0;
    // The second timer is the waiter's no-progress limit; the first is its warning timer.
    const timers: Timers = {
      setTimeout() {
        calls += 1;
        if (calls === 2) {
          throw new Error("no timer");
        }
        return () => {};
      },
    };
    const held = gate();
    const holder = withSendLock(
      "1:0xb4",
      async () => {
        await held.promise;
        return "done";
      },
      timers,
    );
    await assert.rejects(
      withSendLock("1:0xb4", async () => await Promise.resolve("b"), timers),
      /no timer/,
    );
    held.open();
    assert.equal(await holder, "done");
    assert.equal(sendLocksInUse(), 0, "the failed send is not left in the queue");
  });

  it("never trips the limit while each holder takes 100 s", async () => {
    const timers = clockTimers();
    const order: number[] = [];
    const sends = Array.from({ length: 4 }, async (_, index) => {
      await withSendLock(
        "1:0xa7",
        async () => {
          order.push(index);
          await new Promise<void>((resolve) => {
            timers.setTimeout(resolve, 100_000);
          });
        },
        timers,
      );
    });
    for (let step = 0; step < 4; step++) {
      await timers.advance(100_000);
    }
    await Promise.all(sends);
    assert.deepEqual(order, [0, 1, 2, 3]);
    assert.equal(sendLocksInUse(), 0);
    assert.equal(timers.pending(), 0);
  });

  it(`fails the waiter after ${MAX_SEND_LOCK_WAITERS} at once, and runs the others in order`, async () => {
    const timers = clockTimers();
    const held = gate();
    const order: number[] = [];
    const holder = withSendLock("1:0xa8", async () => await held.promise, timers);
    const waiters = Array.from(
      { length: MAX_SEND_LOCK_WAITERS },
      async (_, index) =>
        await withSendLock(
          "1:0xa8",
          async () => {
            order.push(index);
            await Promise.resolve();
          },
          timers,
        ),
    );
    const extra = watch(withSendLock("1:0xa8", async () => await Promise.resolve(), timers));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(extra.done, true, "the extra waiter failed at once");
    assert.match(String(extra.error), QUEUE_FULL("0xa8"));
    assertPluginError(extra.error);
    held.open();
    await Promise.all([holder, ...waiters]);
    assert.deepEqual(
      order,
      Array.from({ length: MAX_SEND_LOCK_WAITERS }, (_, index) => index),
    );
    assert.equal(sendLocksInUse(), 0);
    assert.equal(timers.pending(), 0);
  });

  it("names only the account and chain in its errors", async () => {
    const timers = clockTimers();
    const held = gate();
    const holder = withSendLock("1:0xa9", async () => await held.promise, timers);
    const waiter = watch(withSendLock("1:0xa9", async () => await Promise.resolve(), timers));
    await timers.advance(SEND_LOCK_STALL_MS);
    assert.ok(waiter.error instanceof Error);
    assert.doesNotMatch(waiter.error.message, /1:0xa9/);
    held.open();
    await holder;
    assert.equal(sendLocksInUse(), 0);
  });
});

describe("withSendLock with a signal", () => {
  it("takes a waiter whose signal aborts out of the queue, and keeps the others' order", async () => {
    const timers = clockTimers();
    const held = gate();
    const order: string[] = [];
    const send = async (name: string, signal?: AbortSignal): Promise<void> => {
      await withSendLock(
        "1:0xc1",
        async () => {
          order.push(name);
          await Promise.resolve();
        },
        timers,
        signal,
      );
    };
    const caller = new AbortController();
    const holder = withSendLock("1:0xc1", async () => await held.promise, timers);
    const a = send("a");
    const b = watch(send("b", caller.signal));
    const c = send("c");
    await settle();
    const pendingBefore = timers.pending();
    caller.abort();
    await settle();
    assert.ok(b.error instanceof CancelledError, String(b.error));
    assert.equal(
      timers.pending(),
      pendingBefore - 2,
      "the aborted waiter's limit and wait warning are cancelled",
    );
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    held.open();
    await Promise.all([holder, a, c]);
    assert.deepEqual(order, ["a", "c"]);
    assert.equal(sendLocksInUse(), 0);
  });

  it("fails at once, unqueued, when the signal has already aborted", async () => {
    const timers = clockTimers();
    const held = gate();
    const holder = withSendLock("1:0xc2", async () => await held.promise, timers);
    let ran = false;
    await assert.rejects(
      withSendLock(
        "1:0xc2",
        async () => {
          ran = true;
          await Promise.resolve();
        },
        timers,
        AbortSignal.abort(),
      ),
      CancelledError,
    );
    held.open();
    await holder;
    assert.equal(ran, false);
    assert.equal(sendLocksInUse(), 0, "no waiter was left in the queue");
  });

  it("takes the lock at once when nobody holds it, whatever the signal", async () => {
    assert.equal(
      await withSendLock(
        "1:0xc3",
        async () => await Promise.resolve(7),
        systemTimers,
        AbortSignal.abort(),
      ),
      7,
    );
    assert.equal(sendLocksInUse(), 0);
  });

  it("stops listening once the waiter has the lock, and never cuts the holder short", async () => {
    const timers = clockTimers();
    const held = gate();
    const inside = gate();
    const caller = new AbortController();
    const holder = withSendLock("1:0xc4", async () => await held.promise, timers);
    const waiter = withSendLock(
      "1:0xc4",
      async () => {
        await inside.promise;
        return "done";
      },
      timers,
      caller.signal,
    );
    await settle();
    held.open();
    await holder;
    await settle();
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    caller.abort();
    inside.open();
    assert.equal(await waiter, "done");
    assert.equal(sendLocksInUse(), 0);
  });

  it("ends a library send's wait for the lock, and holds nothing", async () => {
    const key = "1:0xc5";
    const held = gate();
    const holder = withSendLock(key, async () => await held.promise);
    const caller = new AbortController();
    const waiting = watch(
      holdForLibrary(key, {}, async () => await Promise.resolve(3n), fakeTimers(), caller.signal),
    );
    await settle();
    caller.abort();
    await settle();
    assert.ok(waiting.error instanceof CancelledError, String(waiting.error));
    held.open();
    await holder;
    assert.equal(libraryHoldOf(key), undefined);
    assert.equal(sendLocksInUse(), 0);
  });
});

/**
 * A function with no prototype, which the object branch of canonicalJson would write as `{}`.
 *
 * @returns 1.
 */
function bareFunction(): number {
  return 1;
}
Object.setPrototypeOf(bareFunction, null);

describe("canonicalJson", () => {
  it("sorts object keys and drops undefined values", () => {
    assert.equal(
      canonicalJson([{ b: 1, a: "x", c: undefined, d: [null, true] }]),
      canonicalJson([{ d: [null, true], a: "x", b: 1 }]),
    );
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });

  it("keeps the type of each value", () => {
    const forms = [
      canonicalJson(1),
      canonicalJson("1"),
      canonicalJson(1n),
      canonicalJson(new Uint8Array([1])),
      canonicalJson([undefined]),
      canonicalJson([null]),
      canonicalJson({ "1n": 1 }),
    ];
    assert.equal(new Set(forms).size, forms.length, forms.join(" | "));
    assert.equal(canonicalJson(new Uint8Array([0xab, 1])), "bytes(ab01)");
    assert.equal(canonicalJson(Object.create(null)), "{}");
  });

  it("writes a bigint with an n and undefined as a word", () => {
    assert.equal(canonicalJson(true), "true");
    assert.equal(canonicalJson(false), "false");
    assert.equal(canonicalJson(12n), "12n");
    assert.equal(canonicalJson(undefined), "undefined");
    assert.equal(canonicalJson([1n, undefined]), "[1n,undefined]");
  });

  it("refuses values it does not handle", () => {
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(0),
      new Map(),
      [new Set()],
      { nested: { at: new Date(0) } },
      Symbol("x"),
      () => 1,
      bareFunction,
    ]) {
      assert.equal(canonicalJson(value), undefined, typeof value);
    }
  });
});

describe("ConnectionSends", () => {
  it("chooses max(pending, highWater + 1) and only raises the mark", () => {
    const sends = new ConnectionSends({ highWater: true, timers: fakeTimers() });
    assert.equal(sends.nonceFor("0xa", 3n), 3n, "no mark yet: the pending count");
    sends.recordSent("0xa", 3n);
    assert.equal(sends.nonceFor("0xa", 3n), 4n, "the node lags");
    assert.equal(sends.nonceFor("0xa", 9n), 9n, "the node is ahead");
    sends.recordSent("0xa", 1n);
    assert.equal(sends.nonceFor("0xa", 0n), 4n, "a lower nonce does not lower the mark");
    assert.equal(sends.nonceFor("0xb", 0n), 0n, "each sender has its own mark");
    sends.close();
    assert.equal(sends.nonceFor("0xa", 0n), 0n, "closing forgets the marks");
  });

  it("keeps no mark when the high-water mark is off", () => {
    const sends = new ConnectionSends({ highWater: false });
    sends.recordSent("0xa", 5n);
    assert.equal(sends.nonceFor("0xa", 0n), 0n);
  });

  it("serves a retry entry once, for 120 s", () => {
    const timers = fakeTimers();
    const sends = new ConnectionSends({ highWater: true, timers });
    const transaction = { raw: "0x01", hash: "0x02", nonce: 0n };
    sends.rememberFailure("key", transaction);
    assert.deepEqual(timers.delays(), [RETRY_TTL_MS]);
    assert.equal(RETRY_TTL_MS, 120_000);
    assert.equal(sends.takeRetry("other"), undefined);
    assert.equal(sends.takeRetry("key"), transaction);
    assert.equal(sends.takeRetry("key"), undefined, "consumed on the first hit");
    assert.equal(timers.pending(), 0, "taking the entry cancels its timer");

    sends.rememberFailure("key", transaction);
    timers.fire();
    assert.equal(sends.takeRetry("key"), undefined, "expired");
  });

  it("replaces an entry for the same key, and drops entries on close", () => {
    const timers = fakeTimers();
    const sends = new ConnectionSends({ highWater: true, timers });
    const older = { raw: "0x01", hash: "0x02", nonce: 0n };
    const newer = { raw: "0x03", hash: "0x04", nonce: 1n };
    sends.rememberFailure("key", older);
    sends.rememberFailure("key", newer);
    assert.equal(timers.pending(), 1, "the older entry's timer is cancelled");
    assert.equal(sends.takeRetry("key"), newer);

    sends.rememberFailure("a", older);
    sends.rememberFailure("b", newer);
    sends.close();
    assert.equal(timers.pending(), 0);
    assert.equal(sends.takeRetry("a"), undefined);
  });

  it("ignores the timer of an entry that was replaced", () => {
    // Timers that cannot be cancelled, like a timer that fires while it is being cancelled.
    const callbacks: (() => void)[] = [];
    const sends = new ConnectionSends({
      highWater: true,
      timers: {
        setTimeout: (callback) => {
          callbacks.push(callback);
          return () => {};
        },
      },
    });
    const newer = { raw: "0x03", hash: "0x04", nonce: 1n };
    sends.rememberFailure("key", { raw: "0x01", hash: "0x02", nonce: 0n });
    sends.rememberFailure("key", newer);
    callbacks[0]?.();
    assert.equal(sends.takeRetry("key"), newer, "the older timer leaves the newer entry");
  });

  it("remembers nothing after it is closed", () => {
    const timers = fakeTimers();
    const sends = new ConnectionSends({ highWater: true, timers });
    const transaction = { raw: "0x01", hash: "0x02", nonce: 4n };
    sends.close();
    sends.rememberFailure("key", transaction);
    sends.rememberUncertain("0xa", transaction);
    assert.equal(timers.pending(), 0);
    assert.equal(sends.takeRetry("key"), undefined);
    assert.equal(sends.takeUncertain("0xa"), undefined);
  });

  it("keeps one uncertain transaction per sender, until taken or settled", () => {
    const sends = new ConnectionSends({ highWater: true, timers: fakeTimers() });
    const older = { raw: "0x01", hash: "0x02", nonce: 0n };
    const newer = { raw: "0x03", hash: "0x04", nonce: 1n };
    sends.rememberUncertain("0xa", older);
    sends.rememberUncertain("0xa", newer);
    assert.equal(sends.takeUncertain("0xa"), newer);
    assert.equal(sends.takeUncertain("0xa"), undefined);
    sends.rememberUncertain("0xa", older);
    sends.settleUncertain("0xa", newer.hash);
    assert.equal(sends.takeUncertain("0xa"), older, "another hash does not settle it");
    sends.rememberUncertain("0xa", older);
    sends.settleUncertain("0xa", older.hash);
    assert.equal(sends.takeUncertain("0xa"), undefined);
    const off = new ConnectionSends({ highWater: false, timers: fakeTimers() });
    off.rememberUncertain("0xa", older);
    assert.equal(off.takeUncertain("0xa"), undefined, "nothing to raise without a mark");
  });

  it(`drops the oldest of more than ${MAX_RETRY_ENTRIES} entries`, () => {
    const timers = fakeTimers();
    const sends = new ConnectionSends({ highWater: true, timers });
    const transaction = { raw: "0x01", hash: "0x02", nonce: 0n };
    for (let i = 0; i <= MAX_RETRY_ENTRIES; i++) {
      sends.rememberFailure(`key${i}`, transaction);
    }
    // Replacing an entry makes it the newest, so it survives the next drop.
    sends.rememberFailure("key1", transaction);
    sends.rememberFailure("one more", transaction);
    assert.equal(timers.pending(), MAX_RETRY_ENTRIES);
    assert.equal(sends.takeRetry("key0"), undefined);
    assert.equal(sends.takeRetry("key2"), undefined);
    assert.equal(sends.takeRetry("key1"), transaction);
    assert.equal(sends.takeRetry("one more"), transaction);
  });

  it("makes a replaced entry the newest, without dropping another to make room", () => {
    const sends = new ConnectionSends({ highWater: true, timers: fakeTimers() });
    const transaction = { raw: "0x01", hash: "0x02", nonce: 0n };
    for (let i = 0; i < MAX_RETRY_ENTRIES; i++) {
      sends.rememberFailure(`key${i}`, transaction);
    }
    sends.rememberFailure("key5", transaction);
    sends.rememberFailure("one more", transaction);
    assert.equal(sends.takeRetry("key0"), undefined, "the oldest made room for one more");
    assert.equal(sends.takeRetry("key1"), transaction, "replacing key5 made no room");
    for (let i = 0; i < 6; i++) {
      sends.rememberFailure(`later${i}`, transaction);
    }
    assert.equal(sends.takeRetry("key6"), undefined);
    assert.equal(sends.takeRetry("key5"), transaction, "key5 counts as newer than key6");
  });

  it("forgets the uncertain transactions when it is closed", () => {
    const sends = new ConnectionSends({ highWater: true, timers: fakeTimers() });
    sends.rememberUncertain("0xa", { raw: "0x01", hash: "0x02", nonce: 0n });
    sends.close();
    assert.equal(sends.takeUncertain("0xa"), undefined);
  });

  it("drops every retry entry of a hash, and reports the mark only when it is on", () => {
    const timers = fakeTimers();
    const sends = new ConnectionSends({ highWater: true, timers });
    const a = { raw: "0x01", hash: "0xaa", nonce: 0n };
    const b = { raw: "0x02", hash: "0xbb", nonce: 1n };
    sends.rememberFailure("a1", a);
    sends.rememberFailure("b", b);
    sends.rememberFailure("a2", a);
    sends.dropRetriesOf(a.hash);
    assert.equal(timers.pending(), 1);
    assert.equal(sends.takeRetry("a1"), undefined);
    assert.equal(sends.takeRetry("a2"), undefined);
    assert.equal(sends.takeRetry("b"), b);
    assert.equal(sends.highWaterOf("0xa"), undefined);
    sends.recordSent("0xa", 2n);
    assert.equal(sends.highWaterOf("0xa"), 2n);
    const off = new ConnectionSends({ highWater: false, timers });
    off.recordSent("0xa", 2n);
    assert.equal(off.highWaterOf("0xa"), undefined);
  });
});

/** A send state with a clock the test moves. */
function withClock(highWater = true): { sends: ConnectionSends; clock: { now: number } } {
  const clock = { now: 1_000 };
  const sends = new ConnectionSends({ highWater, timers: fakeTimers(), now: () => clock.now });
  return { sends, clock };
}

describe("ConnectionSends nonce reservations", () => {
  const COW = "0xcd2a3d9f938e13cd947ec05abc7fe734df8dd826";
  const ZERO = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

  it("keeps a send above every reservation, the mark and the pending count", () => {
    const { sends } = withClock();
    sends.reserve(COW, 3n);
    sends.reserve(COW, 5n);
    assert.equal(sends.nonceFor(COW, 0n), 6n);
    assert.equal(sends.nonceFor(COW, 9n), 9n);
    sends.recordSent(COW, 7n);
    assert.equal(sends.nonceFor(COW, 0n), 8n);
    assert.equal(sends.nonceFor(ZERO, 2n), 2n, "another sender's reservations do not count");
  });

  it("counts reservations with the high-water mark off too", () => {
    const { sends } = withClock(false);
    sends.reserve(COW, 4n);
    assert.equal(sends.nonceFor(COW, 4n), 5n);
    assert.equal(sends.nonceFor(COW, 6n), 6n);
  });

  it(`stops counting a reservation ${RESERVATION_MS} ms after it was made, with no timer`, () => {
    const { sends, clock } = withClock();
    sends.reserve(COW, 2n);
    clock.now += RESERVATION_MS - 1;
    assert.equal(sends.nonceFor(COW, 0n), 3n);
    clock.now += 1;
    assert.equal(sends.nonceFor(COW, 0n), 0n);
    // Reserved again, it counts again for a full period.
    sends.reserve(COW, 2n);
    clock.now += RESERVATION_MS - 1;
    assert.equal(sends.nonceFor(COW, 0n), 3n);
  });

  it("ends one reservation by its nonce, or every one up to a nonce", () => {
    const { sends } = withClock();
    for (const nonce of [1n, 2n, 3n, 5n]) {
      sends.reserve(COW, nonce);
    }
    sends.releaseReservation(COW, 5n);
    assert.equal(sends.nonceFor(COW, 0n), 4n);
    sends.releaseReservationsUpTo(COW, 2n);
    assert.equal(sends.nonceFor(COW, 0n), 4n, "3 is still reserved");
    sends.releaseReservationsUpTo(COW, 3n);
    assert.equal(sends.nonceFor(COW, 0n), 0n);
    sends.releaseReservation(ZERO, 1n);
    sends.releaseReservationsUpTo(ZERO, 1n);
  });

  it("tells whether live reservations exist, and ends those below the node's pending count", () => {
    const { sends, clock } = withClock();
    assert.equal(sends.hasReservations(COW), false);
    sends.reserve(COW, 1n);
    sends.reserve(COW, 3n);
    assert.equal(sends.hasReservations(COW), true);
    assert.equal(sends.hasReservations(ZERO), false);
    sends.releaseReservationsBelow(COW, 0n);
    sends.releaseReservationsBelow(COW, 1n);
    assert.equal(sends.nonceFor(COW, 0n), 4n, "the node has no transaction with 1 yet");
    sends.releaseReservationsBelow(COW, 3n);
    assert.equal(sends.nonceFor(COW, 0n), 4n, "3 is still reserved");
    sends.releaseReservationsBelow(COW, 4n);
    assert.equal(sends.hasReservations(COW), false);
    sends.reserve(COW, 5n);
    clock.now += RESERVATION_MS;
    assert.equal(sends.hasReservations(COW), false, "an expired one does not count");
  });

  it("resets the newest failed reservation, else the newest unsigned one, else the newest", () => {
    const { sends } = withClock();
    for (const nonce of [1n, 2n, 3n, 4n]) {
      sends.reserve(COW, nonce);
    }
    sends.signedReservation(COW, 3n);
    sends.signedReservation(COW, 4n);
    sends.failReservation(COW, 1n);
    sends.signedReservation(ZERO, 1n);
    sends.failReservation(ZERO, 1n);
    sends.resetReservation(COW);
    // 1 failed: gone. Left: 2 (unsigned), 3 and 4 (signed).
    sends.resetReservation(COW);
    // 2 unsigned: gone. Left: 3 and 4.
    assert.equal(sends.nonceFor(COW, 0n), 5n);
    sends.resetReservation(COW);
    assert.equal(sends.nonceFor(COW, 0n), 4n, "the newest, 4, is gone");
    sends.resetReservation(COW);
    assert.equal(sends.nonceFor(COW, 0n), 0n);
    sends.resetReservation(COW);
    sends.resetReservation(ZERO);
  });

  it("resets a failed reservation before a newer signed one", () => {
    const { sends } = withClock();
    sends.reserve(COW, 5n);
    sends.reserve(COW, 6n);
    sends.signedReservation(COW, 5n);
    sends.signedReservation(COW, 6n);
    sends.failReservation(COW, 5n);
    sends.resetReservation(COW);
    // 5's raw transaction was refused, so the reset is its; 6 is still in flight.
    assert.equal(sends.nonceFor(COW, 6n), 7n, "6 is still reserved");
    sends.resetReservation(COW);
    assert.equal(sends.hasReservations(COW), false, "one reset each: 5 went first");
  });

  it("treats a nonce handed out again as the newest", () => {
    const { sends } = withClock();
    sends.reserve(COW, 1n);
    sends.reserve(COW, 2n);
    sends.reserve(COW, 1n);
    sends.resetReservation(COW);
    assert.equal(sends.nonceFor(COW, 0n), 3n, "1 was reset, 2 stays");
  });

  it("forgets every reservation when the connection closes, and reserves nothing after", () => {
    const { sends } = withClock();
    sends.reserve(COW, 1n);
    sends.close();
    assert.equal(sends.nonceFor(COW, 0n), 0n);
    sends.reserve(COW, 1n);
    assert.equal(sends.nonceFor(COW, 0n), 0n);
  });
});

describe("library holds", () => {
  const HOLDER = "0xcd2a3d9f938e13cd947ec05abc7fe734df8dd826";
  // Each test takes the next chain id, so a test that fails with a hold still open does not leave
  // the next one waiting for it: the run fails at once instead of hanging.
  let chain = 31337;
  /** A lock key of the holder on a chain no other test uses. */
  const nextKey = (): string => `${chain++}:${HOLDER}`;
  /** The holder's address as the warnings print it. */
  const CHECKSUMMED = "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826";
  const DOCS =
    "https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/library-accounts.md#warnings";

  it("keeps the lock after the nonce is chosen, until the broadcast ends the hold", async () => {
    const KEY = nextKey();
    const timers = fakeTimers();
    const owner = {};
    const nonce = await holdForLibrary(KEY, owner, async () => await Promise.resolve(4n), timers);
    assert.equal(nonce, 4n);
    assert.equal(libraryHoldOf(KEY)?.nonce, 4n);
    let ran = false;
    const waiting = withSendLock(KEY, async () => {
      ran = true;
      await Promise.resolve();
    });
    await Promise.resolve();
    assert.equal(ran, false, "a send waits behind the hold");
    assert.deepEqual(timers.delays().includes(LIBRARY_HOLD_MS), true);
    endLibraryHold(KEY, false);
    endLibraryHold(KEY, false);
    await waiting;
    assert.equal(ran, true);
    assert.equal(libraryHoldOf(KEY)?.nonce, undefined);
    assert.equal(
      takeOwedLibraryReset(KEY, owner),
      false,
      "no reset is owed for a broadcast that went out",
    );
    assert.equal(libraryHoldsActive(), false);
    assert.equal(sendLocksInUse(), 0);
  });

  it(`ends the hold after ${LIBRARY_HOLD_MS} ms when nothing else ends it, with a warning`, async () => {
    const KEY = nextKey();
    const warn = mock.method(console, "warn", () => undefined);
    try {
      const timers = fakeTimers();
      await holdForLibrary(KEY, {}, async () => await Promise.resolve(1n), timers);
      timers.fire();
      await withSendLock(KEY, async () => {
        await Promise.resolve();
      });
      assert.equal(libraryHoldOf(KEY)?.nonce, undefined);
      assert.deepEqual(
        warn.mock.calls.map((call) => call.arguments),
        [
          [
            `hardhat-kms: a connection.kms.getAccount send from ${CHECKSUMMED} on chain ${KEY.slice(0, KEY.indexOf(":"))} chose nonce 1, and after 60 s it has neither broadcast it through the connection nor been reset by viem, so the plugin released the account's send lock. Its raw transaction did not reach the plugin, as with a custom transport over another provider. If it is broadcast later, it and the account's next send share a nonce, and the node refuses one of them. Send the library account through custom(connection.provider); see ${DOCS}.`,
          ],
        ],
      );
    } finally {
      warn.mock.restore();
    }
  });

  it("prints no limit warning for a hold that ends before its limit", async () => {
    const KEY = nextKey();
    const warn = mock.method(console, "warn", () => undefined);
    try {
      const timers = fakeTimers();
      await holdForLibrary(KEY, {}, async () => await Promise.resolve(1n), timers);
      endLibraryHold(KEY, false);
      timers.fire();
      await withSendLock(KEY, async () => {
        await Promise.resolve();
      });
      assert.equal(warn.mock.callCount(), 0);
    } finally {
      warn.mock.restore();
    }
  });

  it(`warns once when a send waits ${LIBRARY_WAIT_WARNING_MS} ms behind a hold`, async () => {
    const KEY = nextKey();
    const warn = mock.method(console, "warn", () => undefined);
    try {
      const clock = clockTimers();
      await holdForLibrary(KEY, {}, async () => await Promise.resolve(6n), fakeTimers());
      const waiting = watch(withSendLock(KEY, async () => await Promise.resolve(), clock));
      await clock.advance(LIBRARY_WAIT_WARNING_MS - 1);
      assert.equal(warn.mock.callCount(), 0, "not before the delay");
      await clock.advance(1);
      await clock.advance(SEND_LOCK_STALL_MS - LIBRARY_WAIT_WARNING_MS - 1);
      assert.deepEqual(
        warn.mock.calls.map((call) => call.arguments),
        [
          [
            `hardhat-kms: a send from ${CHECKSUMMED} on chain ${KEY.slice(0, KEY.indexOf(":"))} has waited 5 s for a connection.kms.getAccount send that chose nonce 6 and has not broadcast it through the connection. It waits until that raw transaction goes out, viem resets that send, or 60 s after the nonce was chosen. If the library send's client does not send through custom(connection.provider), send it through that transport; see ${DOCS}.`,
          ],
        ],
        "once per hold",
      );
      endLibraryHold(KEY, false);
      await settle();
      assert.equal(waiting.done, true);
      assert.equal(waiting.error, undefined);
      assert.equal(clock.pending(), 0, "the warning timer is cancelled when the wait ends");
    } finally {
      warn.mock.restore();
    }
  });

  it("warns once for a wait behind two holds in a row, and not after the holds end at close", async () => {
    const KEY = nextKey();
    const warn = mock.method(console, "warn", () => undefined);
    try {
      const clock = clockTimers();
      const owner = {};
      await holdForLibrary(KEY, owner, async () => await Promise.resolve(1n), fakeTimers());
      const second = holdForLibrary(
        KEY,
        owner,
        async () => await Promise.resolve(2n),
        fakeTimers(),
      );
      const waiting = watch(withSendLock(KEY, async () => await Promise.resolve(), clock));
      endLibraryHold(KEY, false);
      assert.equal(await second, 2n);
      await clock.advance(LIBRARY_WAIT_WARNING_MS * 3);
      assert.equal(warn.mock.callCount(), 1, "one warning per wait");
      assert.match(String(warn.mock.calls[0]?.arguments[0]), /chose nonce 2 /);
      endLibraryHold(KEY, false);
      await settle();
      assert.equal(waiting.done, true);

      await holdForLibrary(KEY, owner, async () => await Promise.resolve(3n), fakeTimers());
      const closing = watch(withSendLock(KEY, async () => await Promise.resolve(), clock));
      endLibraryHoldsOf(owner);
      await settle();
      assert.equal(closing.done, true);
      await clock.advance(LIBRARY_WAIT_WARNING_MS * 2);
      assert.equal(warn.mock.callCount(), 1, "no warning after the connection closed");
      assert.equal(sendLocksInUse(), 0);
    } finally {
      warn.mock.restore();
    }
  });

  it("warns once per hold, however many sends wait behind it", async () => {
    const KEY = nextKey();
    const warn = mock.method(console, "warn", () => undefined);
    try {
      const clock = clockTimers();
      await holdForLibrary(KEY, {}, async () => await Promise.resolve(8n), fakeTimers());
      const waiters = [0, 1, 2].map((index) =>
        watch(withSendLock(KEY, async () => await Promise.resolve(index), clock)),
      );
      await clock.advance(LIBRARY_WAIT_WARNING_MS);
      assert.equal(warn.mock.callCount(), 1);
      endLibraryHold(KEY, false);
      await settle();
      assert.ok(waiters.every((waiter) => waiter.done && waiter.error === undefined));
      assert.equal(sendLocksInUse(), 0);
    } finally {
      warn.mock.restore();
    }
  });

  it("ignores a second end of a hold, even after a newer hold started", async () => {
    const KEY = nextKey();
    const first = await holdForLibrary(
      KEY,
      {},
      async () => await Promise.resolve(1n),
      fakeTimers(),
    );
    assert.equal(first, 1n);
    const old = libraryHoldOf(KEY);
    assert.ok(old !== undefined);
    old.end();
    await holdForLibrary(KEY, {}, async () => await Promise.resolve(2n), fakeTimers());
    old.end();
    assert.equal(libraryHoldOf(KEY)?.nonce, 2n, "the newer hold stays");
    endLibraryHold(KEY, false);
    await settle();
    assert.equal(sendLocksInUse(), 0);
  });

  it("warns and ends a hold before a send waiting behind it could stall", () => {
    assert.ok(LIBRARY_WAIT_WARNING_MS < LIBRARY_HOLD_MS);
    assert.ok(LIBRARY_HOLD_MS < SEND_LOCK_STALL_MS);
  });

  it("does not warn for a wait behind a plugin send, or one shorter than the delay", async () => {
    const KEY = nextKey();
    const warn = mock.method(console, "warn", () => undefined);
    try {
      const clock = clockTimers();
      const plugin = gate();
      const holder = withSendLock(KEY, async () => await plugin.promise);
      const behindPlugin = watch(withSendLock(KEY, async () => await Promise.resolve(), clock));
      await clock.advance(LIBRARY_WAIT_WARNING_MS * 2);
      plugin.open();
      await holder;
      await settle();
      assert.equal(behindPlugin.done, true);

      await holdForLibrary(KEY, {}, async () => await Promise.resolve(2n), fakeTimers());
      const short = watch(withSendLock(KEY, async () => await Promise.resolve(), clock));
      await clock.advance(LIBRARY_WAIT_WARNING_MS - 1);
      endLibraryHold(KEY, false);
      await settle();
      assert.equal(short.done, true);
      assert.equal(clock.pending(), 0, "its warning timer is cancelled");
      await clock.advance(LIBRARY_WAIT_WARNING_MS);
      assert.equal(warn.mock.callCount(), 0);
      assert.equal(sendLocksInUse(), 0);
    } finally {
      warn.mock.restore();
    }
  });

  it("owes no reset for a failed broadcast when no library send holds the lock", () => {
    const KEY = nextKey();
    endLibraryHold(KEY, true);
    assert.equal(libraryHoldsActive(), false);
  });

  it("uses up the resets owed by failed sends before it ends a hold", async () => {
    const KEY = nextKey();
    const timers = fakeTimers();
    const owner = {};
    expectLibraryReset(KEY, owner);
    await holdForLibrary(KEY, owner, async () => await Promise.resolve(2n), timers);
    endLibraryHold(KEY, true);
    expectLibraryReset(KEY, owner);
    await holdForLibrary(KEY, owner, async () => await Promise.resolve(3n), timers);
    assert.equal(takeOwedLibraryReset(KEY, {}), false, "another connection's reset owes nothing");
    // Owed: the first expected reset, the failed broadcast of 2, and the second expected reset.
    for (let i = 0; i < 3; i++) {
      assert.equal(takeOwedLibraryReset(KEY, owner), true, "owed");
      assert.equal(libraryHoldOf(KEY)?.nonce, 3n, "the hold is still there");
    }
    assert.equal(takeOwedLibraryReset(KEY, owner), false, "the next reset is the hold's own");
    assert.equal(libraryHoldsActive(), true);
    libraryHoldOf(KEY)?.end();
    assert.equal(libraryHoldOf(KEY)?.nonce, undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sendLocksInUse(), 0);
  });

  it("ends the holds a connection gave when its send state closes", async () => {
    const KEY = nextKey();
    const timers: Timers = { setTimeout: () => () => {} };
    const sends = new ConnectionSends({ highWater: true, timers });
    assert.equal(
      await holdForLibrary(KEY, sends, async () => await Promise.resolve(3n), timers),
      3n,
    );
    sends.close();
    assert.equal(libraryHoldOf(KEY), undefined);
    await settle();
    assert.equal(sendLocksInUse(), 0);
  });

  it("ends only the holds of a closing connection", async () => {
    const KEY = nextKey();
    const timers = fakeTimers();
    const mine = {};
    const other = {};
    const otherKey = `${KEY}0`;
    await holdForLibrary(KEY, mine, async () => await Promise.resolve(1n), timers);
    await holdForLibrary(otherKey, other, async () => await Promise.resolve(1n), timers);
    endLibraryHoldsOf(mine);
    assert.equal(libraryHoldOf(KEY)?.nonce, undefined);
    assert.equal(libraryHoldOf(otherKey)?.nonce, 1n);
    endLibraryHoldsOf(other);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sendLocksInUse(), 0);
  });

  it("holds nothing when the nonce cannot be chosen, and throws its error", async () => {
    const KEY = nextKey();
    await assert.rejects(
      holdForLibrary(KEY, {}, async () => {
        throw await Promise.resolve(new Error("no node"));
      }),
      /no node/,
    );
    assert.equal(libraryHoldOf(KEY)?.nonce, undefined);
    assert.equal(sendLocksInUse(), 0);
  });

  it("keeps the process alive while a hold lasts, by default", async () => {
    const KEY = nextKey();
    const timers = fakeTimers();
    const done = holdForLibrary(KEY, {}, async () => await Promise.resolve(9n));
    assert.equal(await done, 9n);
    assert.equal(timers.pending(), 0, "the default timers are real, and the test ends the hold");
    endLibraryHold(KEY, false);
  });
});
