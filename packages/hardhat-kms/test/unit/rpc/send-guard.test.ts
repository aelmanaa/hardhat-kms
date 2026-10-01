import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canonicalJson,
  ConnectionSends,
  MAX_RETRY_ENTRIES,
  RETRY_TTL_MS,
  sendLocksInUse,
  withSendLock,
} from "../../../src/internal/rpc/send-guard.ts";
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
});
