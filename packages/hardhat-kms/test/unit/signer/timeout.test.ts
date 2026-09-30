import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { systemTimers, TimeoutError, withTimeout } from "../../../src/internal/signer/timeout.ts";
import { fakeTimers } from "../../helpers/fake-timers.ts";

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

    timers.fire();
    await assert.rejects(pending, TimeoutError);
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
});
