// One test that waits 30 s, unless the runner cancels it (Node 24 and later, which aborts the wait) or
// ends the file (Node 22).
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

test("slow test", async (t) => {
  await sleep(30_000, undefined, { signal: t.signal });
});
