// Five passing tests of 500 ms each: 2.5 s for the file, which is more than the 2 s per-test limit
// `test/scripts/node-test.test.ts` runs it with.
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

for (const number of [1, 2, 3, 4, 5]) {
  test(`passing test ${number}`, async () => {
    await sleep(500);
  });
}
