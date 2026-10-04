// One test that waits 30 s unless the runner cancels it, which aborts the wait.
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

test("slow test", async (t) => {
  await sleep(30_000, undefined, { signal: t.signal });
});
