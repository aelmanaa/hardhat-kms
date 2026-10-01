// The shared/exclusive lock that keeps the fork's replacement cases away from other providers'
// sends. Runs in `pnpm test`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SharedLock } from "./helpers/lock.ts";

/** A step that logs its start and end, and ends when `release` is called. */
function step(log: string[], name: string) {
  const gate: { open?: () => void } = {};
  const done = new Promise<void>((resolve) => {
    gate.open = resolve;
  });
  return {
    run: async (): Promise<string> => {
      log.push(`${name} start`);
      await done;
      log.push(`${name} end`);
      return name;
    },
    release: () => {
      gate.open?.();
    },
  };
}

const tick = async (): Promise<void> => {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
};

describe("SharedLock", () => {
  it("lets shared holders run together", async () => {
    const lock = new SharedLock();
    const log: string[] = [];
    const a = step(log, "a");
    const b = step(log, "b");
    const running = [lock.shared(a.run), lock.shared(b.run)];
    await tick();
    assert.deepEqual(log, ["a start", "b start"]);
    a.release();
    b.release();
    assert.deepEqual(await Promise.all(running), ["a", "b"]);
  });

  it("runs an exclusive holder alone, and holds later shared ones until it ends", async () => {
    const lock = new SharedLock();
    const log: string[] = [];
    const a = step(log, "a");
    const x = step(log, "x");
    const b = step(log, "b");
    const running = [lock.shared(a.run), lock.exclusive(x.run), lock.shared(b.run)];
    await tick();
    assert.deepEqual(log, ["a start"], "x waits for a, and b waits behind x");
    a.release();
    await tick();
    assert.deepEqual(log, ["a start", "a end", "x start"]);
    x.release();
    await tick();
    assert.deepEqual(log, ["a start", "a end", "x start", "x end", "b start"]);
    b.release();
    await Promise.all(running);
  });

  it("releases the lock when a step throws", async () => {
    const lock = new SharedLock();
    await assert.rejects(
      lock.exclusive(async () => {
        await Promise.reject(new Error("boom"));
      }),
      /boom/,
    );
    assert.equal(await lock.shared(async () => await Promise.resolve("next")), "next");
  });
});
