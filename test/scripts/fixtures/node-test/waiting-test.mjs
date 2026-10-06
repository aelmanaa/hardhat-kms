// Prints the process id of the test runner that started this file, then waits until a signal ends
// the run.
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

test("waiting test", async (t) => {
  process.stderr.write(`RUNNER ${process.ppid}\n`);
  await sleep(60_000, undefined, { signal: t.signal });
});
