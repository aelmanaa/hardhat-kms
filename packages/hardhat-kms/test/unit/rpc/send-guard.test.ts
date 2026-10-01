import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardhatPluginError } from "hardhat/plugins";

import { PLUGIN_ID } from "../../../src/internal/constants.ts";
import {
  canonicalJson,
  ConnectionSends,
  MAX_RETRY_ENTRIES,
  MAX_SEND_LOCK_WAITERS,
  RETRY_TTL_MS,
  SEND_LOCK_STALL_MS,
  sendLocksInUse,
  withSendLock,
} from "../../../src/internal/rpc/send-guard.ts";
import type { Timers } from "../../../src/internal/signer/timeout.ts";
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
    assert.equal(scheduled.length, 3, "one limit per waiter");
    const limitOfB = scheduled[1];
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
