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
  type LookUpTransaction,
  MAX_SEND_LOCK_WAITERS,
  MAX_SENT_RECORDS,
  MAX_UNCERTAIN_RECORDS,
  RESERVATION_MS,
  takeOwedLibraryReset,
  RETRY_TTL_MS,
  SEND_LOCK_STALL_MS,
  sendLocksInUse,
  withSendLock,
} from "../../../src/internal/rpc/send-guard.ts";
import { CancelledError, systemTimers, type Timers } from "../../../src/internal/signer/timeout.ts";
import { fakeTimers } from "../../helpers/fake-timers.ts";

/** The send state of a new connection, to own library holds. */
function newOwner(): ConnectionSends {
  return new ConnectionSends({ highWater: true, timers: fakeTimers() });
}

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
      holdForLibrary(
        key,
        newOwner(),
        async () => await Promise.resolve(3n),
        fakeTimers(),
        caller.signal,
      ),
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
    sends.recordSent("0xa", 3n, "0x03");
    assert.equal(sends.nonceFor("0xa", 3n), 4n, "the node lags");
    assert.equal(sends.nonceFor("0xa", 9n), 9n, "the node is ahead");
    sends.recordSent("0xa", 1n, "0x01");
    assert.equal(sends.nonceFor("0xa", 0n), 4n, "a lower nonce does not lower the mark");
    assert.equal(sends.nonceFor("0xb", 0n), 0n, "each sender has its own mark");
    sends.close();
    assert.equal(sends.nonceFor("0xa", 0n), 0n, "closing forgets the marks");
  });

  it("keeps no mark when the high-water mark is off", () => {
    const sends = new ConnectionSends({ highWater: false });
    sends.recordSent("0xa", 5n, "0x05");
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
    assert.deepEqual(sends.takeUncertain("0xa"), []);
  });

  it("keeps every uncertain transaction per sender, oldest first, until taken or settled (#506)", () => {
    const sends = new ConnectionSends({ highWater: true, timers: fakeTimers() });
    const older = { raw: "0x01", hash: "0x02", nonce: 0n };
    const newer = { raw: "0x03", hash: "0x04", nonce: 1n };
    const sameNonce = { raw: "0x05", hash: "0x06", nonce: 0n };
    sends.rememberUncertain("0xa", older);
    sends.rememberUncertain("0xa", newer);
    sends.rememberUncertain("0xa", sameNonce);
    sends.rememberUncertain("0xb", newer);
    assert.deepEqual(sends.takeUncertain("0xa"), [older, newer, sameNonce]);
    assert.deepEqual(sends.takeUncertain("0xa"), []);
    assert.deepEqual(sends.takeUncertain("0xb"), [newer], "per sender");
    sends.rememberUncertain("0xa", older);
    sends.rememberUncertain("0xa", newer);
    sends.settleUncertain("0xa", newer.hash);
    sends.settleUncertain("0xb", older.hash);
    assert.deepEqual(sends.takeUncertain("0xa"), [older], "only that hash is settled");
    sends.rememberUncertain("0xa", older);
    sends.settleUncertain("0xa", older.hash);
    assert.deepEqual(sends.takeUncertain("0xa"), []);
    assert.equal(sends.highWaterOf("0xa"), undefined, "nothing is counted as sent");
    const off = new ConnectionSends({ highWater: false, timers: fakeTimers() });
    off.rememberUncertain("0xa", older);
    assert.deepEqual(off.takeUncertain("0xa"), [older], "kept with the mark off too (#434)");
    off.close();
    off.rememberUncertain("0xa", newer);
    assert.deepEqual(off.takeUncertain("0xa"), [], "nothing after close");
  });

  it(`counts the oldest of more than ${MAX_UNCERTAIN_RECORDS} uncertain transactions as sent`, () => {
    const sends = new ConnectionSends({ highWater: true, timers: fakeTimers() });
    const kept = Array.from({ length: MAX_UNCERTAIN_RECORDS + 2 }, (_, index) => ({
      raw: "0x01",
      hash: `0x${index.toString(16).padStart(2, "0")}`,
      // Nonces in no order: the oldest is evicted, not the lowest.
      nonce: BigInt((index * 7) % 23),
    }));
    for (const transaction of kept.slice(0, MAX_UNCERTAIN_RECORDS)) {
      sends.rememberUncertain("0xa", transaction);
    }
    const [first, second] = kept;
    assert.ok(first !== undefined && second !== undefined);
    // The same transaction again is the newest, and takes no room.
    sends.rememberUncertain("0xa", first);
    assert.equal(sends.highWaterOf("0xa"), undefined, "nothing evicted yet");
    sends.rememberUncertain("0xa", kept.at(-2) ?? first);
    assert.equal(sends.highWaterOf("0xa"), second.nonce, "the oldest counts as sent");
    sends.rememberUncertain("0xa", kept.at(-1) ?? first);
    const left = sends.takeUncertain("0xa");
    assert.equal(left.length, MAX_UNCERTAIN_RECORDS);
    assert.deepEqual(left, [...kept.slice(3, MAX_UNCERTAIN_RECORDS), first, ...kept.slice(-2)]);
    // The third went too; the mark is the higher of the two nonces.
    const third = kept[2];
    assert.ok(third !== undefined);
    assert.equal(sends.highWaterOf("0xa"), second.nonce > third.nonce ? second.nonce : third.nonce);
    const off = new ConnectionSends({ highWater: false, timers: fakeTimers() });
    for (const transaction of kept) {
      off.rememberUncertain("0xa", transaction);
    }
    assert.equal(off.sentRecords("0xa"), 2, "recorded with the mark off too");
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
    assert.deepEqual(sends.takeUncertain("0xa"), []);
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
    sends.recordSent("0xa", 2n, "0x02");
    assert.equal(sends.highWaterOf("0xa"), 2n);
    const off = new ConnectionSends({ highWater: false, timers });
    off.recordSent("0xa", 2n, "0x02");
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
  const COW_KEY = `1:${COW}`;
  const ZERO_KEY = `1:${ZERO}`;

  it("keeps a send above every reservation, the mark and the pending count", () => {
    const { sends } = withClock();
    sends.reserve(COW, 3n);
    sends.reserve(COW, 5n);
    assert.equal(sends.nonceFor(COW, 0n), 6n);
    assert.equal(sends.nonceFor(COW, 9n), 9n);
    sends.recordSent(COW, 7n, "0x07");
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

  it("tells whether live reservations exist", () => {
    const { sends, clock } = withClock();
    assert.equal(sends.hasReservations(COW), false);
    sends.reserve(COW, 1n);
    sends.reserve(COW, 3n);
    assert.equal(sends.hasReservations(COW), true);
    assert.equal(sends.hasReservations(ZERO), false);
    sends.releaseReservation(COW, 1n);
    sends.releaseReservation(COW, 3n);
    assert.equal(sends.hasReservations(COW), false);
    sends.reserve(COW, 5n);
    clock.now += RESERVATION_MS;
    assert.equal(sends.hasReservations(COW), false, "an expired one does not count");
  });

  it("resets the newest failed reservation, else the only one, else none", () => {
    const { sends } = withClock();
    for (const nonce of [1n, 2n, 3n, 4n]) {
      sends.reserve(COW, nonce);
    }
    sends.signedReservation(COW, 3n);
    sends.signedReservation(COW, 4n);
    sends.failReservation(COW, 1n);
    sends.failReservation(COW, 3n);
    sends.signedReservation(ZERO, 1n);
    sends.failReservation(ZERO, 1n);
    sends.resetReservation(COW_KEY);
    assert.equal(sends.nonceFor(COW, 3n), 5n, "3 failed last: gone; 4 stays");
    assert.equal(sends.nonceFor(COW, 0n), 5n);
    sends.resetReservation(COW_KEY);
    // 1 failed: gone. Left: 2 (unsigned) and 4 (signed), either of which the next reset may be.
    sends.resetReservation(COW_KEY);
    assert.equal(sends.nonceFor(COW, 0n), 5n, "a signed and an unsigned one: neither ends");
    sends.releaseReservation(COW, 4n);
    assert.equal(sends.hasReservations(COW), false, "4 reached the node, so 2 failed");
    sends.resetReservation(COW_KEY);
    sends.resetReservation(ZERO_KEY);
  });

  it("resets a failed reservation before a newer signed one", () => {
    const { sends } = withClock();
    sends.reserve(COW, 5n);
    sends.reserve(COW, 6n);
    sends.signedReservation(COW, 5n);
    sends.signedReservation(COW, 6n);
    sends.failReservation(COW, 5n);
    sends.resetReservation(COW_KEY);
    // 5's raw transaction was refused, so the reset is its; 6 is still in flight.
    assert.equal(sends.nonceFor(COW, 6n), 7n, "6 is still reserved");
    sends.resetReservation(COW_KEY);
    assert.equal(sends.hasReservations(COW), false, "one reset each: 5 went first");
  });

  it("treats a nonce handed out again as the newest", () => {
    const { sends } = withClock();
    sends.reserve(COW, 1n);
    sends.reserve(COW, 2n);
    sends.reserve(COW, 1n);
    sends.failReservation(COW, 2n);
    sends.failReservation(COW, 1n);
    sends.resetReservation(COW_KEY);
    assert.equal(sends.nonceFor(COW, 0n), 3n, "1 was reset, 2 stays");
  });

  it("warns about a gap only for a hold-limit reservation with a higher nonce used since", async (t) => {
    const warn = t.mock.method(console, "warn", () => undefined);
    const gaps = (): string[] =>
      warn.mock.calls
        .map((call) => String(call.arguments[0]))
        .filter((message) => message.includes("gap"))
        .map((message) => /with nonce (\d+) after/.exec(message)?.[1] ?? message);
    const { sends } = withClock();
    sends.reserve(COW, 0n, true);
    sends.resetReservation(COW_KEY);
    assert.deepEqual(gaps(), [], "nothing above it: no gap");
    sends.reserve(COW, 0n, true);
    sends.recordSent(COW, 0n, "0x00");
    sends.resetReservation(COW_KEY);
    assert.deepEqual(gaps(), [], "a mark at its own nonce is no gap");
    sends.reserve(COW, 1n, true);
    sends.recordSent(COW, 2n, "0x02");
    sends.resetReservation(COW_KEY);
    assert.deepEqual(gaps(), ["1"], "the mark is above it");
    const { sends: other } = withClock(false);
    other.reserve(COW, 3n, true);
    other.reserve(COW, 4n);
    other.signedReservation(COW, 4n);
    other.failReservation(COW, 3n);
    other.resetReservation(COW_KEY);
    assert.deepEqual(gaps(), ["1", "3"], "another reservation is above it");
    other.resetReservation(COW_KEY);
    assert.deepEqual(gaps(), ["1", "3"], "4 is a client's reservation, not a gap");
    other.reserve(COW, 5n);
    other.reserve(COW, 6n);
    other.signedReservation(COW, 6n);
    other.resetReservation(COW_KEY);
    other.resetReservation(COW_KEY);
    other.resetReservation(COW_KEY);
    assert.equal(other.hasReservations(COW), false, "nothing left to reset");
    assert.deepEqual(gaps(), ["1", "3"], "5 and 6 are a client's reservations, not gaps");
    other.reserve(COW, 7n);
    other.signedReservation(COW, 7n);
    other.reserve(COW, 8n, true);
    other.failReservation(COW, 8n);
    other.resetReservation(COW_KEY);
    assert.equal(other.nonceFor(COW, 0n), 8n, "8 ended");
    assert.deepEqual(gaps(), ["1", "3"], "a reservation below it is no gap");
    const timers = fakeTimers();
    const KEY = `31390:${COW}`;
    const owner = withClock(false).sends;
    await holdForLibrary(KEY, owner, async () => await Promise.resolve(9n), timers);
    try {
      owner.reserve(COW, 9n, true);
      owner.resetReservation(KEY);
      assert.deepEqual(gaps(), ["1", "3"], "a hold at its own nonce is no gap");
      owner.reserve(COW, 8n, true);
      owner.resetReservation(KEY);
      assert.deepEqual(gaps(), ["1", "3", "8"], "a hold of this connection above it");
      const stranger = withClock(false).sends;
      stranger.reserve(COW, 8n, true);
      stranger.resetReservation(KEY);
      assert.deepEqual(gaps(), ["1", "3", "8"], "another connection's hold does not count");
    } finally {
      endLibraryHold(KEY, false);
    }
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /on chain 1 with nonce 1 after/);
  });

  it("keeps a hold-limit reservation past a higher plugin send, but not past its own nonce", () => {
    const { sends } = withClock();
    sends.reserve(COW, 1n, true);
    sends.reserve(COW, 2n);
    sends.releaseReservationsUpTo(COW, 3n);
    assert.equal(sends.nonceFor(COW, 0n), 2n, "1 stays, 2 is gone");
    sends.releaseReservationsUpTo(COW, 0n);
    assert.equal(sends.nonceFor(COW, 0n), 2n, "a lower nonce ends nothing");
    sends.releaseReservationsUpTo(COW, 1n);
    assert.equal(sends.hasReservations(COW), false, "a send with its very nonce ends it");
  });

  it("keeps every reservation at a reset that matches several unsigned ones (#434)", () => {
    const { sends } = withClock();
    sends.reserve(COW, 0n);
    sends.reserve(COW, 1n);
    sends.reserve(COW, 2n);
    sends.signedReservation(COW, 2n);
    sends.resetReservation(COW_KEY);
    assert.equal(sends.nonceFor(COW, 0n), 3n, "0, 1 and the signed 2 all stay");
    sends.signedReservation(COW, 1n);
    // 1 signed after the reset, so the reset was 0's: 0 ends.
    sends.releaseReservation(COW, 1n);
    sends.releaseReservation(COW, 2n);
    assert.equal(sends.hasReservations(COW), false);
  });

  it("settles owed resets when the candidates left are no more than the resets (#434)", () => {
    const { sends } = withClock();
    for (const nonce of [0n, 1n, 2n]) {
      sends.reserve(COW, nonce);
    }
    sends.resetReservation(COW_KEY);
    sends.resetReservation(COW_KEY);
    assert.equal(sends.nonceFor(COW, 0n), 3n, "two resets, three candidates: none ends");
    // A reservation made after the resets is no candidate.
    sends.reserve(COW, 3n);
    sends.signedReservation(COW, 2n);
    assert.equal(sends.nonceFor(COW, 0n), 4n, "3 and the signed 2 stay");
    sends.releaseReservation(COW, 3n);
    sends.releaseReservation(COW, 2n);
    assert.equal(sends.hasReservations(COW), false, "0 and 1 both failed");
  });

  it("settles an owed reset when a candidate fails, or when its raw transaction reaches the node (#434)", () => {
    const { sends } = withClock();
    sends.reserve(COW, 0n);
    sends.reserve(COW, 1n);
    sends.resetReservation(COW_KEY);
    sends.failReservation(COW, 1n);
    assert.equal(sends.nonceFor(COW, 0n), 2n, "1 failed after the reset, so 0 ended; 1 stays");
    sends.resetReservation(COW_KEY);
    assert.equal(sends.hasReservations(COW), false, "1's own reset");
    const { sends: other } = withClock();
    other.reserve(COW, 0n);
    other.reserve(COW, 1n);
    other.resetReservation(COW_KEY);
    other.releaseReservation(COW, 1n);
    assert.equal(other.hasReservations(COW), false, "the node has 1, so the reset was 0's");
    const { sends: third } = withClock();
    third.reserve(COW, 0n);
    third.reserve(COW, 1n);
    third.resetReservation(COW_KEY);
    third.releaseReservationsUpTo(COW, 0n);
    assert.equal(third.nonceFor(COW, 0n), 2n, "the reset may have been 0's: 1 stays");
    third.reserve(COW, 2n);
    third.signedReservation(COW, 2n);
    assert.equal(third.nonceFor(COW, 0n), 3n, "the reset counts as settled: 1 stays");
    third.releaseReservation(COW, 2n);
    assert.equal(third.nonceFor(COW, 0n), 2n, "1 stays on its own");
    third.reserve(COW, 2n);
    third.reserve(COW, 4n, true);
    third.resetReservation(COW_KEY);
    third.releaseReservationsUpTo(COW, 3n);
    assert.equal(third.nonceFor(COW, 0n), 5n, "1 and 2 end; the hold-limit 4 stays");
    third.signedReservation(COW, 4n);
    assert.equal(third.nonceFor(COW, 0n), 5n, "1 was the only candidate it ended");
  });

  it("warns once when expiry settles an owed reset, and keeps the other candidates (#434)", async (t) => {
    const warn = t.mock.method(console, "warn", () => undefined);
    const owed = (): string[] =>
      warn.mock.calls
        .map((call) => String(call.arguments[0]))
        .filter((message) => message.includes("without saying which"));
    const { sends, clock } = withClock();
    sends.reserve(COW, 0n);
    clock.now += 1;
    sends.reserve(COW, 1n);
    sends.reserve(COW, 2n);
    sends.resetReservation(COW_KEY);
    clock.now += RESERVATION_MS - 1;
    assert.equal(sends.nonceFor(COW, 0n), 3n, "0 expired; 1 and 2 stay");
    assert.equal(owed().length, 1);
    assert.match(
      owed()[0] ?? "",
      /from 0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826 on chain 1 that had reserved a nonce.*The reservation of nonce 0 has now ended after 60 s.*had nonce 0, .*Check the node for nonce 0 first \(https:\/\/github\.com\/aelmanaa\/hardhat-kms\/blob\/main\/docs\/user\/guides\/uncertain-sends\.md#2-look-the-transaction-up\), and fill the gap only if it is one, with an explicit nonce \(https:\/\/github\.com\/aelmanaa\/hardhat-kms\/blob\/main\/docs\/user\/guides\/uncertain-sends\.md#4-fill-a-gap-or-replace-a-transaction\)\./,
    );
    sends.signedReservation(COW, 2n);
    assert.equal(sends.nonceFor(COW, 0n), 3n, "the settled reset ends no candidate");
    clock.now += 1;
    assert.equal(sends.nonceFor(COW, 0n), 0n);
    assert.equal(owed().length, 1, "no reset is owed any more");
  });

  it("names every candidate that expires at once, and keeps a reset owed for the others (#434)", async (t) => {
    const warn = t.mock.method(console, "warn", () => undefined);
    const owed = (): string[] =>
      warn.mock.calls
        .map((call) => String(call.arguments[0]))
        .filter((message) => message.includes("without saying which"));
    const { sends, clock } = withClock();
    sends.reserve(COW, 0n);
    sends.reserve(COW, 1n);
    sends.reserve(COW, 2n);
    clock.now += 1;
    sends.reserve(COW, 3n);
    sends.reserve(COW, 4n);
    sends.resetReservation(COW_KEY);
    sends.resetReservation(COW_KEY);
    sends.resetReservation(COW_KEY);
    sends.signedReservation(COW, 2n);
    clock.now += RESERVATION_MS - 1;
    assert.equal(sends.hasReservations(COW), true, "3 and 4 stay");
    assert.equal(owed().length, 1);
    assert.match(owed()[0] ?? "", /nonce 0 or 1 has now ended/);
    // One reset is still owed, with 3 and 4 its candidates: 4 signs, so 3 failed.
    sends.signedReservation(COW, 4n);
    assert.equal(sends.nonceFor(COW, 0n), 5n);
    sends.releaseReservation(COW, 4n);
    assert.equal(sends.hasReservations(COW), false);
  });

  for (const highWater of [true, false]) {
    for (const settlement of ["reset", "signature", "failure"] as const) {
      it(`warns about an ordinary reservation gap on ${settlement}, highWater=${highWater}`, (t) => {
        const warning = t.mock.method(console, "warn", () => undefined);
        const sends = new ConnectionSends({ highWater, timers: fakeTimers() });
        sends.reserve(COW, 0n);
        if (settlement !== "reset") {
          sends.reserve(COW, 1n);
          sends.resetReservation(COW_KEY);
        }
        sends.recordSent(COW, 2n, "0x02");
        if (settlement === "reset") {
          sends.resetReservation(COW_KEY);
        } else if (settlement === "signature") {
          sends.signedReservation(COW, 1n);
        } else {
          sends.failReservation(COW, 1n);
        }
        assert.equal(warning.mock.callCount(), 1);
        const message = String(warning.mock.calls[0]?.arguments[0]);
        assert.match(message, /with nonce 0/);
        assert.match(message, /check the node for nonce 0 first/);
        assert.match(message, /explicit nonce/);
        sends.nonceFor(COW, 0n);
        assert.equal(warning.mock.callCount(), 1, "no duplicate warning on a later nonce read");
        sends.close();
      });
    }
  }

  it("warns about no owed reset when a reservation expires with none owed", async (t) => {
    const warn = t.mock.method(console, "warn", () => undefined);
    const { sends, clock } = withClock();
    sends.reserve(COW, 0n);
    sends.reserve(COW, 1n);
    sends.resetReservation(COW_KEY);
    sends.signedReservation(COW, 1n);
    sends.reserve(COW, 2n);
    clock.now += RESERVATION_MS;
    assert.equal(sends.hasReservations(COW), false);
    assert.equal(warn.mock.callCount(), 0);
  });

  it("keeps a reservation signed before a reset a candidate when it signs again (#434)", () => {
    const { sends } = withClock();
    sends.reserve(COW, 0n);
    sends.reserve(COW, 1n);
    sends.signedReservation(COW, 0n);
    sends.resetReservation(COW_KEY);
    // 0 had signed before the reset, so signing again says nothing new: viem resets after a
    // broadcast that timed out too. Both stay candidates, and the one reset ends neither.
    sends.signedReservation(COW, 0n);
    assert.equal(sends.nonceFor(COW, 0n), 2n, "0 and 1 both stay");
    sends.signedReservation(COW, 1n);
    assert.equal(sends.nonceFor(COW, 0n), 2n, "1 signed after the reset; 0 is the candidate");
    sends.releaseReservation(COW, 1n);
    assert.equal(sends.hasReservations(COW), false, "0 failed, and its reset ends it");
  });

  it("never counts a reservation made after a reset as its candidate (#434)", () => {
    const { sends } = withClock();
    sends.reserve(COW, 0n);
    sends.reserve(COW, 1n);
    sends.resetReservation(COW_KEY);
    sends.reserve(COW, 2n);
    sends.signedReservation(COW, 1n);
    // 1 signed, so the reset was 0's; 2 came later and is no candidate.
    sends.releaseReservation(COW, 1n);
    assert.equal(sends.nonceFor(COW, 0n), 3n, "2 stays");
    sends.releaseReservation(COW, 2n);
    assert.equal(sends.hasReservations(COW), false, "0 ended");
  });

  it("ends the failed candidate at once when a later reservation is open too (#434)", async (t) => {
    const warn = t.mock.method(console, "warn", () => undefined);
    const { sends, clock } = withClock();
    sends.reserve(COW, 0n);
    sends.reserve(COW, 1n);
    sends.resetReservation(COW_KEY);
    clock.now += 1;
    sends.reserve(COW, 2n);
    sends.signedReservation(COW, 1n);
    clock.now += RESERVATION_MS - 1;
    assert.equal(sends.nonceFor(COW, 0n), 3n);
    assert.equal(warn.mock.callCount(), 0, "0 had ended, so its expiry settles nothing");
  });

  it("forgets an owed reset once it is settled (#434)", () => {
    const { sends } = withClock();
    sends.reserve(COW, 0n);
    sends.reserve(COW, 1n);
    sends.resetReservation(COW_KEY);
    sends.signedReservation(COW, 1n);
    sends.releaseReservation(COW, 1n);
    assert.equal(sends.hasReservations(COW), false, "1 signed, so 0 failed");
    sends.reserve(COW, 2n);
    sends.reserve(COW, 3n);
    sends.resetReservation(COW_KEY);
    assert.equal(sends.nonceFor(COW, 0n), 4n, "one reset for two candidates ends neither");
    sends.releaseReservation(COW, 3n);
    assert.equal(sends.hasReservations(COW), false, "3 reached the node, so 2 failed");
  });

  it("warns about a gap when a reset ends a signed hold-limit reservation (#434)", async (t) => {
    const warn = t.mock.method(console, "warn", () => undefined);
    const { sends } = withClock();
    sends.reserve(COW, 1n, true);
    sends.signedReservation(COW, 1n);
    sends.recordSent(COW, 2n, "0x02");
    sends.resetReservation(COW_KEY);
    assert.equal(sends.hasReservations(COW), false);
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /with nonce 1 after its 60 s hold/);
  });

  it("with the mark off, counts a nonce the node took above a live reservation (#434)", () => {
    const { sends } = withClock(false);
    sends.recordSent(COW, 4n, "0x04");
    assert.equal(sends.nonceFor(COW, 0n), 0n, "no reservation below it: the pending count decides");
    sends.reserve(COW, 1n);
    assert.equal(sends.nonceFor(COW, 0n), 5n, "a reservation made later, below it");
    sends.recordSent(COW, 7n, "0x07");
    assert.equal(sends.nonceFor(COW, 0n), 8n);
    assert.equal(sends.nonceFor(ZERO, 0n), 0n, "another sender's");
    sends.releaseReservation(COW, 1n);
    assert.equal(sends.nonceFor(COW, 0n), 0n, "with no reservation below, the node decides");
    sends.reserve(COW, 4n);
    assert.equal(sends.nonceFor(COW, 0n), 8n, "a reservation at 4 is below 7, not below 4");
    sends.releaseReservation(COW, 4n);
    sends.reserve(COW, 7n);
    assert.equal(sends.nonceFor(COW, 0n), 8n);
    sends.releaseReservation(COW, 7n);
    sends.reserve(COW, 0n);
    assert.equal(sends.nonceFor(COW, 7n), 8n, "the node does not count 7 at a pending count of 7");
    assert.equal(sends.nonceFor(COW, 8n), 8n, "the node counts 7 at 8, and 4 too");
    assert.equal(
      sends.nonceFor(COW, 0n),
      8n,
      "a read without lookups keeps both: after a fall the node may hold them again",
    );
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

/** A transaction hash for a nonce, in the #489 tests. */
function hash(nonce: bigint): string {
  return `0x${nonce.toString(16).padStart(64, "0")}`;
}

/**
 * A fake node's answers to `eth_getTransactionByHash`: `true` when it has the transaction,
 * `false` when it does not, `undefined` when the lookup fails. Each lookup is counted.
 */
function node(held: Iterable<bigint> = [], failing: Iterable<bigint> = []) {
  const has = new Set([...held].map(hash));
  const fails = new Set([...failing].map(hash));
  const lookedUp: string[] = [];
  return {
    has,
    lookedUp,
    lookUp: async (asked: string): Promise<boolean | undefined> => {
      await Promise.resolve();
      lookedUp.push(asked);
      return fails.has(asked) ? undefined : has.has(asked);
    },
  };
}

describe("ConnectionSends after the pending count falls (#489)", () => {
  const COW = "0xcd2a3d9f938e13cd947ec05abc7fe734df8dd826";

  /** A send through the plugin: the nonce choice, then the node takes the transaction. */
  async function send(
    sends: ConnectionSends,
    pending: bigint,
    fake: ReturnType<typeof node>,
  ): Promise<bigint> {
    const nonce = await sends.chooseNonce(COW, pending, fake.lookUp);
    sends.recordSent(COW, nonce, hash(nonce));
    fake.has.add(hash(nonce));
    return nonce;
  }

  it("takes the first nonce the node no longer has after a fall (the #489 repro)", async () => {
    const { sends } = withClock(false);
    for (let nonce = 0n; nonce < 5n; nonce++) {
      sends.recordSent(COW, nonce, hash(nonce));
    }
    sends.reserve(COW, 0n);
    // A reset: the node has none of them.
    const fake = node();
    assert.equal(await sends.chooseNonce(COW, 0n, fake.lookUp), 1n);
    assert.deepEqual(fake.lookedUp, [1n, 2n, 3n, 4n].map(hash), "each above the count, once");
  });

  it("keeps a nonce whose transaction the node still has, or whose lookup fails", async () => {
    const { sends } = withClock(false);
    for (let nonce = 0n; nonce < 5n; nonce++) {
      sends.recordSent(COW, nonce, hash(nonce));
    }
    sends.reserve(COW, 0n);
    const fake = node([1n, 3n], [2n]);
    assert.equal(await sends.chooseNonce(COW, 0n, fake.lookUp), 4n, "1 held, 2 unknown, 3 held");
    assert.equal(sends.nonceFor(COW, 0n), 5n, "a read without lookups keeps every record");
  });

  it("does not move a reservation that outlives a fall, and fills below it", async () => {
    const { sends } = withClock(false);
    const fake = node();
    assert.equal(await send(sends, 0n, fake), 0n);
    assert.equal(await send(sends, 1n, fake), 1n);
    assert.equal(await send(sends, 2n, fake), 2n);
    assert.equal(await sends.chooseNonce(COW, 3n, fake.lookUp), 3n);
    sends.reserve(COW, 3n);
    // hardhat_reset: the node has nothing, and the library client still has nonce 3.
    fake.has.clear();
    assert.equal(sends.nonceFor(COW, 0n), 0n, "a read after the fall");
    assert.deepEqual(
      [await send(sends, 0n, fake), await send(sends, 1n, fake), await send(sends, 2n, fake)],
      [0n, 1n, 2n],
    );
    assert.equal(await send(sends, 3n, fake), 4n, "3 is still reserved");
    assert.equal(sends.hasReservations(COW), true);
  });

  it("never takes a nonce the node still holds after a dropped transaction", async () => {
    const { sends } = withClock(false);
    const fake = node();
    for (const pending of [0n, 1n, 2n]) {
      await send(sends, pending, fake);
    }
    assert.equal(await sends.chooseNonce(COW, 3n, fake.lookUp), 3n);
    sends.reserve(COW, 3n);
    assert.equal(await send(sends, 3n, fake), 4n);
    // hardhat_dropTransaction(1): the node keeps 2 and 4, and its pending count falls to 1.
    fake.has.delete(hash(1n));
    assert.equal(await send(sends, 1n, fake), 1n);
    assert.equal(await send(sends, 3n, fake), 5n, "3 reserved, 4 held");
  });

  it("never takes a nonce a revert brings back, even one recorded below the pending count", async () => {
    const { sends } = withClock(false);
    const fake = node();
    // A library client on its own transport takes 0; the plugin sends 1 past it.
    assert.equal(await sends.chooseNonce(COW, 0n, fake.lookUp), 0n);
    sends.reserve(COW, 0n);
    assert.equal(await send(sends, 0n, fake), 1n);
    // evm_snapshot; the library's 0 reaches the node, which now counts 0 and 1.
    fake.has.add(hash(0n));
    assert.equal(await send(sends, 2n, fake), 2n);
    // evm_revert: the node has the queued 1 again, and nothing else.
    fake.has.clear();
    fake.has.add(hash(1n));
    const library = await sends.chooseNonce(COW, 0n, fake.lookUp);
    assert.equal(library, 2n, "0 is still reserved and 1 is held");
    sends.reserve(COW, library);
    assert.equal(await send(sends, 0n, fake), 3n);
  });

  it("looks a nonce up again before it takes it, so a revert that restores it counts", async () => {
    const { sends } = withClock(false);
    const fake = node();
    assert.equal(await sends.chooseNonce(COW, 0n, fake.lookUp), 0n);
    sends.reserve(COW, 0n);
    assert.equal(await send(sends, 0n, fake), 1n);
    assert.equal(await send(sends, 0n, fake), 2n);
    fake.has.delete(hash(2n));
    fake.has.delete(hash(1n));
    sends.reserve(COW, 1n);
    assert.equal(await sends.chooseNonce(COW, 0n, fake.lookUp), 2n, "1 reserved, 2 gone");
    // A revert brings 2 back before the send that would take it.
    fake.has.add(hash(2n));
    fake.lookedUp.length = 0;
    assert.equal(await sends.chooseNonce(COW, 0n, fake.lookUp), 3n, "2 is held again");
    assert.deepEqual(fake.lookedUp, [hash(2n)]);
  });

  it("sees a fall through its newest record when the pending count does not fall", async () => {
    const { sends } = withClock(false);
    const fake = node();
    assert.equal(await sends.chooseNonce(COW, 0n, fake.lookUp), 0n);
    sends.reserve(COW, 0n);
    assert.equal(await send(sends, 0n, fake), 1n);
    assert.equal(await send(sends, 0n, fake), 2n);
    // A revert to before both sends: the pending count stays 0, and the reservation outlives it.
    fake.has.clear();
    assert.equal(await sends.chooseNonce(COW, 0n, fake.lookUp), 1n);
  });

  it("asks the node nothing without a reservation, and nothing with the mark on", async () => {
    const { sends } = withClock(false);
    const fake = node();
    for (let pending = 0n; pending < 3n; pending++) {
      await send(sends, pending, fake);
    }
    fake.has.clear();
    assert.equal(await sends.chooseNonce(COW, 0n, fake.lookUp), 0n);
    assert.deepEqual(fake.lookedUp, []);
    const { sends: http } = withClock(true);
    http.recordSent(COW, 4n, hash(4n));
    http.reserve(COW, 0n);
    assert.equal(await http.chooseNonce(COW, 0n, fake.lookUp), 5n, "the mark decides, as before");
    assert.deepEqual(fake.lookedUp, []);
    assert.equal(http.sentRecords(COW), 0);
  });

  it("keeps a bounded record after many sends, none of it counted as sent ahead", async () => {
    const { sends } = withClock(false);
    const fake = node();
    for (let pending = 0n; pending < 1000n; pending++) {
      assert.equal(await send(sends, pending, fake), pending);
    }
    assert.equal(sends.sentRecords(COW), MAX_SENT_RECORDS);
    // A dropped nonce recorded again is a new record: the next oldest goes, and the count holds.
    sends.recordSent(COW, 0n, "0xagain");
    assert.equal(sends.sentRecords(COW), MAX_SENT_RECORDS);
    // No queued transaction: a reservation at the pending count is the only nonce to skip.
    sends.reserve(COW, 1000n);
    assert.equal(sends.nonceFor(COW, 1000n), 1001n);
    assert.equal(await sends.chooseNonce(COW, 1000n, fake.lookUp), 1001n);
  });

  it("does not fill a nonce whose record it dropped to stay bounded", async () => {
    const { sends } = withClock(false);
    const fake = node();
    const total = BigInt(MAX_SENT_RECORDS) + 2n;
    for (let pending = 0n; pending < total; pending++) {
      await send(sends, pending, fake);
    }
    // 0 and 1 left the record. A fall to 0 with 0 reserved: the node may still hold 1.
    fake.has.clear();
    fake.has.add(hash(1n));
    sends.reserve(COW, 0n);
    assert.equal(await sends.chooseNonce(COW, 0n, fake.lookUp), 2n);
  });

  it("sees a fall through a record at the pending count, with the newest still held", async () => {
    const { sends } = withClock(false);
    const fake = node();
    assert.equal(await sends.chooseNonce(COW, 0n, fake.lookUp), 0n);
    sends.reserve(COW, 0n);
    assert.equal(await send(sends, 0n, fake), 1n);
    assert.equal(await send(sends, 0n, fake), 2n);
    // The library's 0 reaches the node, then hardhat_dropTransaction(1): the count falls to 1.
    fake.has.delete(hash(1n));
    assert.equal(await sends.chooseNonce(COW, 1n, fake.lookUp), 1n);
  });

  it("sees a fall through the pending count alone when no record of its own was lost", async () => {
    const { sends } = withClock(false);
    const fake = node();
    assert.equal(await sends.chooseNonce(COW, 0n, fake.lookUp), 0n);
    sends.reserve(COW, 0n);
    assert.equal(await send(sends, 0n, fake), 1n);
    // The library's 0 reaches the node on its own transport, and the count is 2.
    assert.equal(await send(sends, 2n, fake), 2n);
    // hardhat_dropTransaction of the library's 0: the count falls to 0, and 1 and 2 stay.
    sends.reserve(COW, 5n);
    assert.equal(await sends.chooseNonce(COW, 0n, fake.lookUp), 3n, "not past 5");
  });

  it("looks each record up once per fall", async () => {
    const { sends } = withClock(false);
    const fake = node();
    for (const pending of [0n, 1n, 2n]) {
      await send(sends, pending, fake);
    }
    fake.has.clear();
    // The fall is seen with no reservation: nothing is looked up yet.
    assert.equal(await sends.chooseNonce(COW, 0n, fake.lookUp), 0n);
    sends.reserve(COW, 0n);
    assert.equal(await sends.chooseNonce(COW, 0n, fake.lookUp), 1n);
    assert.deepEqual(fake.lookedUp, [1n, 2n].map(hash));
    assert.equal(await sends.chooseNonce(COW, 0n, fake.lookUp), 1n);
    assert.deepEqual(fake.lookedUp, [1n, 2n, 1n].map(hash), "only the gone nonce it takes");
  });

  it("returns to the rule before the fall once nothing above the pending count may be held", async () => {
    const { sends } = withClock(false);
    const fake = node();
    for (const pending of [0n, 1n, 2n]) {
      await send(sends, pending, fake);
    }
    fake.has.clear();
    assert.equal(await send(sends, 0n, fake), 0n);
    assert.equal(await send(sends, 1n, fake), 1n);
    assert.equal(await sends.chooseNonce(COW, 2n, fake.lookUp), 2n);
    // A library client takes 2 and 4: before a fall, a send goes past both, not between them.
    sends.reserve(COW, 2n);
    sends.reserve(COW, 4n);
    assert.equal(sends.nonceFor(COW, 2n), 5n);
  });

  it("before a fall, goes past held records only, and looks the nonce it takes up again", async () => {
    const { sends } = withClock(false);
    const fake = node();
    for (const pending of [0n, 1n, 2n]) {
      await send(sends, pending, fake);
    }
    assert.equal(await sends.chooseNonce(COW, 3n, fake.lookUp), 3n);
    sends.reserve(COW, 3n);
    fake.has.clear();
    assert.equal(await send(sends, 0n, fake), 0n, "1 and 2 are gone");
    sends.releaseReservation(COW, 3n);
    assert.equal(await sends.chooseNonce(COW, 1n, fake.lookUp), 1n);
    sends.reserve(COW, 1n);
    fake.lookedUp.length = 0;
    assert.equal(await sends.chooseNonce(COW, 1n, fake.lookUp), 2n, "2 is gone");
    assert.deepEqual(fake.lookedUp, [hash(0n), hash(2n)], "the newest record, then 2 again");
  });

  it("returns the pending count when the reservation ends during a lookup", async () => {
    const { sends } = withClock(false);
    const fake = node();
    assert.equal(await sends.chooseNonce(COW, 0n, fake.lookUp), 0n);
    sends.reserve(COW, 0n);
    assert.equal(await send(sends, 0n, fake), 1n);
    assert.equal(await send(sends, 0n, fake), 2n);
    const lookUp = async (asked: string): Promise<boolean | undefined> => {
      sends.releaseReservation(COW, 0n);
      return await fake.lookUp(asked);
    };
    // 1 and 2 are still held, so without the reservation the pending count is the nonce.
    assert.equal(await sends.chooseNonce(COW, 0n, lookUp), 0n);
  });

  it("skips a nonce at the highest one whose record it dropped, and takes the next", async () => {
    const { sends } = withClock(false);
    const fake = node();
    assert.equal(await send(sends, 0n, fake), 0n);
    assert.equal(await sends.chooseNonce(COW, 1n, fake.lookUp), 1n);
    sends.reserve(COW, 1n);
    // Past the reservation at 1 until the record is full, so the first record (0) is dropped.
    for (let sent = 1; sent <= MAX_SENT_RECORDS; sent++) {
      await send(sends, 1n, fake);
    }
    assert.equal(sends.sentRecords(COW), MAX_SENT_RECORDS);
    // hardhat_reset, and a library client takes 0 again: 1, which no record has, is free.
    sends.releaseReservation(COW, 1n);
    fake.has.clear();
    sends.reserve(COW, 0n);
    assert.equal(await sends.chooseNonce(COW, 0n, fake.lookUp), 1n);
  });

  it("keeps the rule after a fall while a record above the pending count may be held", async () => {
    const { sends } = withClock(false);
    const fake = node();
    for (const pending of [0n, 1n, 2n]) {
      await send(sends, pending, fake);
    }
    // hardhat_dropTransaction(0) and (1): the node keeps 2, queued.
    fake.has.delete(hash(0n));
    fake.has.delete(hash(1n));
    assert.equal(await sends.chooseNonce(COW, 0n, fake.lookUp), 0n);
    sends.reserve(COW, 0n);
    sends.reserve(COW, 3n);
    assert.equal(await sends.chooseNonce(COW, 0n, fake.lookUp), 1n, "below 2, between the two");
  });

  it("does not warn about a gap below a record the node no longer has", async (t) => {
    const warning = t.mock.method(console, "warn", () => undefined);
    const { sends } = withClock(false);
    const fake = node();
    for (const pending of [0n, 1n, 2n]) {
      await send(sends, pending, fake);
    }
    fake.has.clear();
    sends.reserve(COW, 0n);
    assert.equal(await sends.chooseNonce(COW, 0n, fake.lookUp), 1n, "1 and 2 are gone");
    sends.resetReservation(`1:${COW}`);
    assert.equal(sends.hasReservations(COW), false);
    assert.equal(warning.mock.callCount(), 0);
    sends.recordSent(COW, 2n, hash(2n));
    sends.reserve(COW, 1n);
    sends.resetReservation(`1:${COW}`);
    assert.equal(warning.mock.callCount(), 1, "a held record above it is a gap");
  });

  it("keeps every hash at a nonce, so a revert that restores the first one counts", async () => {
    const { sends } = withClock(false);
    const fake = node();
    for (const pending of [0n, 1n, 2n]) {
      await send(sends, pending, fake);
    }
    assert.equal(await sends.chooseNonce(COW, 3n, fake.lookUp), 3n);
    sends.reserve(COW, 3n);
    assert.equal(await send(sends, 3n, fake), 4n);
    const snapshot = new Set(fake.has);
    // hardhat_dropTransaction of the queued 4: a second transaction takes 4.
    fake.has.delete(hash(4n));
    assert.equal(await sends.chooseNonce(COW, 3n, fake.lookUp), 4n);
    sends.recordSent(COW, 4n, "0xsecond");
    fake.has.add("0xsecond");
    // evm_revert: the first transaction at 4 is back, the second is gone.
    fake.has.clear();
    for (const held of snapshot) {
      fake.has.add(held);
    }
    fake.lookedUp.length = 0;
    assert.equal(await sends.chooseNonce(COW, 3n, fake.lookUp), 5n);
    assert.deepEqual(
      fake.lookedUp,
      ["0xsecond", hash(4n)],
      "the newest, then each until one is held",
    );
    assert.equal(sends.sentRecords(COW), 5, "both hashes count toward the limit");
  });

  it("keeps the hash a caller-nonce replacement replaced, for a revert that restores it", async () => {
    const { sends } = withClock(false);
    const fake = node();
    assert.equal(await sends.chooseNonce(COW, 0n, fake.lookUp), 0n);
    sends.reserve(COW, 0n);
    assert.equal(await send(sends, 0n, fake), 1n);
    // evm_snapshot, then a replacement with the caller's nonce 1 and a higher fee.
    sends.recordSent(COW, 1n, "0xreplacement");
    sends.recordSent(COW, 1n, "0xreplacement");
    assert.equal(sends.sentRecords(COW), 2, "a hash recorded twice counts once");
    // evm_revert: the original at 1 is back.
    assert.equal(await sends.chooseNonce(COW, 0n, fake.lookUp), 2n);
  });

  it("forgets the records when the connection closes", async () => {
    const { sends } = withClock(false);
    await send(sends, 0n, node());
    sends.close();
    assert.equal(sends.sentRecords(COW), 0);
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
    const owner = newOwner();
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

  it(`ends the hold after ${LIBRARY_HOLD_MS} ms when nothing else ends it, reserves its nonce and warns`, async () => {
    const KEY = nextKey();
    const address = KEY.slice(KEY.indexOf(":") + 1);
    const warn = mock.method(console, "warn", () => undefined);
    try {
      const timers = fakeTimers();
      const owner = newOwner();
      await holdForLibrary(KEY, owner, async () => await Promise.resolve(1n), timers);
      assert.equal(owner.hasReservations(address), false, "no reservation while it holds");
      let chosen: bigint | undefined;
      const waiting = withSendLock(KEY, async () => {
        chosen = owner.nonceFor(address, 1n);
        await Promise.resolve();
      });
      timers.fire();
      await waiting;
      assert.equal(chosen, 2n, "the send that waited skips the held nonce");
      assert.equal(owner.nonceFor(address, 0n), 2n, "the nonce stays reserved after it");
      assert.equal(libraryHoldOf(KEY)?.nonce, undefined);
      assert.deepEqual(
        warn.mock.calls.map((call) => call.arguments),
        [
          [
            `hardhat-kms: a connection.kms.getAccount send from ${CHECKSUMMED} on chain ${KEY.slice(0, KEY.indexOf(":"))} chose nonce 1, and after 60 s it has neither broadcast it through the connection nor been reset by viem, so the plugin released the account's send lock and reserved the nonce: the account's sends through its connection skip it for up to 60 s. Its raw transaction did not reach the plugin, as with a custom transport over another provider. If it is broadcast after that, it and another send of the account can share the nonce, and either can replace the other or be refused. Send the library account through custom(connection.provider); see ${DOCS}.`,
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
      await holdForLibrary(KEY, newOwner(), async () => await Promise.resolve(1n), timers);
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
      await holdForLibrary(KEY, newOwner(), async () => await Promise.resolve(6n), fakeTimers());
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
      const owner = newOwner();
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
      await holdForLibrary(KEY, newOwner(), async () => await Promise.resolve(8n), fakeTimers());
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
      newOwner(),
      async () => await Promise.resolve(1n),
      fakeTimers(),
    );
    assert.equal(first, 1n);
    const old = libraryHoldOf(KEY);
    assert.ok(old !== undefined);
    old.end();
    await holdForLibrary(KEY, newOwner(), async () => await Promise.resolve(2n), fakeTimers());
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

      await holdForLibrary(KEY, newOwner(), async () => await Promise.resolve(2n), fakeTimers());
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
    const owner = newOwner();
    expectLibraryReset(KEY, owner);
    await holdForLibrary(KEY, owner, async () => await Promise.resolve(2n), timers);
    endLibraryHold(KEY, true);
    expectLibraryReset(KEY, owner);
    await holdForLibrary(KEY, owner, async () => await Promise.resolve(3n), timers);
    assert.equal(
      takeOwedLibraryReset(KEY, newOwner()),
      false,
      "another connection's reset owes nothing",
    );
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
    const mine = newOwner();
    const other = newOwner();
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
      holdForLibrary(KEY, newOwner(), async () => {
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
    const done = holdForLibrary(KEY, newOwner(), async () => await Promise.resolve(9n));
    assert.equal(await done, 9n);
    assert.equal(timers.pending(), 0, "the default timers are real, and the test ends the hold");
    endLibraryHold(KEY, false);
  });
});

/** A node that has none of the transactions it is asked about. */
const notKnown: LookUpTransaction = async () => await Promise.resolve(false);
/** A node that has every transaction it is asked about. */
const known: LookUpTransaction = async () => await Promise.resolve(true);

describe("ConnectionSends outstanding nonces (#537)", () => {
  const COW = "0xcd2a3d9f938e13cd947ec05abc7fe734df8dd826";
  const ZERO = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

  it("skips a held nonce with the mark on, and leaves other senders alone", () => {
    const { sends } = withClock();
    sends.holdOutstanding(COW, 0n);
    assert.equal(sends.nonceFor(COW, 0n), 1n);
    assert.equal(sends.nonceFor(COW, 2n), 2n, "a nonce the node has passed is no longer at risk");
    assert.equal(sends.nonceFor(ZERO, 0n), 0n);
    assert.deepEqual(sends.outstandingNonces(COW), [0n]);
    assert.deepEqual(sends.outstandingNonces(ZERO), []);
  });

  it("skips a held nonce with the mark off, and past the sends after its gap", async () => {
    const { sends } = withClock(false);
    assert.equal(await sends.chooseNonce(COW, 0n, notKnown), 0n);
    sends.holdOutstanding(COW, 0n);
    assert.equal(await sends.chooseNonce(COW, 0n, notKnown), 1n);
    sends.recordSent(COW, 1n, "0x01");
    // The node's pending count stops at the gap; the record above it counts.
    assert.equal(await sends.chooseNonce(COW, 0n, known), 2n);
    assert.equal(sends.nonceFor(COW, 0n), 2n);
  });

  it("keeps every held nonce until a transaction with it is recorded, in the order they were held", () => {
    const { sends } = withClock();
    sends.holdOutstanding(COW, 5n);
    sends.holdOutstanding(COW, 2n);
    sends.holdOutstanding(COW, 5n);
    assert.deepEqual(sends.outstandingNonces(COW), [5n, 2n]);
    sends.recordSent(COW, 3n, "0x03");
    assert.deepEqual(sends.outstandingNonces(COW), [5n, 2n]);
    sends.recordSent(COW, 5n, "0x05");
    assert.deepEqual(sends.outstandingNonces(COW), [2n]);
    sends.recordSent(ZERO, 2n, "0x02");
    assert.deepEqual(sends.outstandingNonces(COW), [2n]);
    sends.recordSent(COW, 2n, "0x02");
    assert.deepEqual(sends.outstandingNonces(COW), []);
    assert.equal(sends.nonceFor(COW, 0n), 6n, "the mark keeps the recorded nonces used");
  });

  it("with the mark off, ends the hold for the copy itself, and for another transaction only once mined", async () => {
    const { sends } = withClock(false);
    sends.holdOutstanding(COW, 0n, "0xc0");
    sends.recordSent(COW, 0n, "0xc0");
    assert.deepEqual(sends.outstandingNonces(COW), [], "the copy reached the node");

    sends.holdOutstanding(COW, 1n, "0xc1");
    sends.holdOutstanding(COW, 2n);
    sends.recordSent(COW, 1n, "0x01");
    sends.recordSent(COW, 2n, "0x02");
    assert.deepEqual(sends.outstandingNonces(COW), [1n, 2n], "another transaction stands in");
    // The pending count passes them, but the node can still drop those pool transactions.
    await sends.chooseNonce(COW, 3n, notKnown);
    sends.nonceFor(COW, 3n);
    assert.deepEqual(sends.outstandingNonces(COW), [1n, 2n]);
    sends.settleMined(COW, 2n);
    assert.deepEqual(sends.outstandingNonces(COW), [2n], "nonce 1 is mined");
    sends.settleMined(COW, 2n);
    sends.settleMined(ZERO, 9n);
    assert.deepEqual(sends.outstandingNonces(COW), [2n]);
    sends.settleMined(COW, 3n);
    assert.deepEqual(sends.outstandingNonces(COW), []);
  });

  it("keeps a timed-out copy held when its replacement leaves the pool (QA4 repro)", async () => {
    const { sends } = withClock(false);
    const A = COW;
    sends.holdOutstanding(A, 5n);
    sends.recordSent(A, 5n, "0xr5");
    assert.equal(await sends.chooseNonce(A, 6n, notKnown), 6n);
    // The replacement R leaves the pool: the node's pending count falls back to 5.
    assert.equal(await sends.chooseNonce(A, 5n, notKnown), 6n, "the never-broadcast copy holds 5");
    assert.deepEqual(sends.outstandingNonces(A), [5n]);
  });

  it("with the mark off, ends a hold with a second copy only once mined", () => {
    const { sends } = withClock(false);
    sends.holdOutstanding(COW, 0n);
    sends.holdOutstanding(COW, 0n, "0xc0");
    sends.recordSent(COW, 0n, "0xc0");
    assert.deepEqual(sends.outstandingNonces(COW), [0n], "the first copy was never broadcast");
    sends.holdOutstanding(COW, 1n, "0xc1");
    sends.holdOutstanding(COW, 1n, "0xd1");
    // The first copy reached the node, but the second one, never broadcast, may still be valid.
    sends.recordSent(COW, 1n, "0xc1");
    assert.deepEqual(sends.outstandingNonces(COW), [0n, 1n]);
    sends.settleMined(COW, 1n);
    assert.deepEqual(sends.outstandingNonces(COW), [1n], "nonce 0 is mined");
  });

  it("with the mark on, ends the hold at any transaction recorded at the nonce", () => {
    const { sends } = withClock();
    sends.holdOutstanding(COW, 0n, "0xc0");
    sends.recordSent(COW, 0n, "0x00");
    assert.deepEqual(sends.outstandingNonces(COW), []);
  });

  it("outlives every reservation limit and reset, and counts as no reservation", () => {
    const { sends, clock } = withClock();
    sends.holdOutstanding(COW, 0n);
    assert.equal(sends.hasReservations(COW), false, "viem's reset then ends a library hold");
    sends.reserve(COW, 1n);
    sends.resetReservation(`1:${COW}`);
    clock.now += RESERVATION_MS * 10;
    assert.equal(sends.hasReservations(COW), false);
    assert.equal(sends.nonceFor(COW, 0n), 1n);
    assert.deepEqual(sends.outstandingNonces(COW), [0n]);
  });

  it("forgets the held nonces when it is closed, and holds none after", () => {
    const { sends } = withClock();
    sends.holdOutstanding(COW, 0n);
    sends.close();
    assert.deepEqual(sends.outstandingNonces(COW), []);
    sends.holdOutstanding(COW, 1n);
    assert.deepEqual(sends.outstandingNonces(COW), []);
    assert.equal(sends.nonceFor(COW, 0n), 0n);
  });
});
