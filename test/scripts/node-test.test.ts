// The test runner script of the packages' `test:unit` and `test:integration` scripts
// (`scripts/node-test.ts`): which `--test-timeout` value each Node major gets, and what that value
// does to the fixture files in `fixtures/node-test/` on the Node that runs this file. The fixtures
// run with limits of a few seconds in place of the real ones.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  LIMITS,
  nodeMajor,
  PER_TEST_SINCE_MAJOR,
  startNodeTest,
  type TestLimits,
  testTimeoutMs,
} from "../../scripts/node-test.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "scripts/node-test.ts");
const fixtures = path.join(root, "test/scripts/fixtures/node-test");

/** Whether `--test-timeout` limits each test on the Node that runs this file. */
const perTest = nodeMajor() >= PER_TEST_SINCE_MAJOR;

/**
 * The environment of a fixture run. `node --test` sets NODE_TEST_CONTEXT for the files it runs; a
 * nested `node --test` that inherits it reports to a parent runner that is not there.
 */
function fixtureEnv(): NodeJS.ProcessEnv {
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  return env;
}

/** Waits for a child started with piped output, and returns how it ended and what it printed. */
async function finished(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
  }
  return await new Promise((resolve) => {
    child.on("close", (code, signal) => {
      resolve({ code, signal, output });
    });
  });
}

/** Runs fixture files through `startNodeTest` with the given limits. */
async function runFixtures(
  limits: TestLimits,
  ...files: string[]
): Promise<{ code: number | null; output: string }> {
  const child = startNodeTest(
    limits,
    files.map((file) => path.join(fixtures, file)),
    { stdio: ["ignore", "pipe", "pipe"], env: fixtureEnv() },
  );
  return await finished(child);
}

/** Starts the script itself, as a package script does. */
function startScript(...args: string[]): ChildProcess {
  return spawn(process.execPath, [script, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: fixtureEnv(),
  });
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("testTimeoutMs", () => {
  const limits: TestLimits = { perTestMs: 1, fileBudgetMs: 2 };

  it("is the file budget before Node 24", () => {
    assert.equal(testTimeoutMs(22, limits), 2);
    assert.equal(testTimeoutMs(23, limits), 2);
  });

  it("is the per-test limit on Node 24 and later", () => {
    assert.equal(testTimeoutMs(24, limits), 1);
    assert.equal(testTimeoutMs(26, limits), 1);
  });

  it("reads the major from a Node version", () => {
    assert.equal(nodeMajor("22.13.0"), 22);
    assert.equal(nodeMajor("24.0.0"), 24);
    assert.equal(nodeMajor(), Number(process.versions.node.split(".")[0]));
  });

  it("pins the limits of each kind of test, the file budget above the per-test limit", () => {
    assert.deepEqual(LIMITS, {
      unit: { perTestMs: 30_000, fileBudgetMs: 300_000 },
      integration: { perTestMs: 120_000, fileBudgetMs: 600_000 },
    });
  });
});

describe("startNodeTest", () => {
  it("passes a file whose passing tests together run longer than the per-test limit", async () => {
    // 5 tests of 500 ms: over the 2 s per-test limit as a file, and under the file budget.
    const { code, output } = await runFixtures(
      { perTestMs: 2000, fileBudgetMs: 60_000 },
      "passing-file.mjs",
    );
    assert.equal(code, 0, output);
    assert.match(output, /pass 5\b/);
  });

  it("cancels a test at the per-test limit on Node 24 and later, and a file at its budget on Node 22", async () => {
    const limits: TestLimits = { perTestMs: 1000, fileBudgetMs: 3000 };
    const started = Date.now();
    const { code, output } = await runFixtures(limits, "slow-test.mjs");
    const elapsed = Date.now() - started;
    assert.equal(code, 1, output);
    assert.match(output, /cancelled 1\b/);
    if (perTest) {
      assert.match(output, /slow test[^]*test timed out after 1000ms/);
    } else {
      assert.match(output, /slow-test\.mjs[^]*test timed out after 3000ms/);
      assert.ok(elapsed >= limits.fileBudgetMs, `the file ended after ${elapsed} ms`);
    }
  });
});

describe("scripts/node-test.ts", () => {
  it("exits 0 when the tests pass", async () => {
    const { code, signal, output } = await finished(
      startScript("unit", "--test-concurrency=1", path.join(fixtures, "passing-file.mjs")),
    );
    assert.deepEqual({ code, signal }, { code: 0, signal: null }, output);
    assert.match(output, /pass 5\b/);
  });

  it("exits with the test runner's code when a test fails", async () => {
    const { code, signal, output } = await finished(
      startScript("integration", path.join(fixtures, "failing-test.mjs")),
    );
    assert.deepEqual({ code, signal }, { code: 1, signal: null }, output);
    assert.match(output, /fail 1\b/);
  });

  it("refuses a kind of test it has no limits for", async () => {
    for (const args of [[], ["live", path.join(fixtures, "passing-file.mjs")]]) {
      const { code, output } = await finished(startScript(...args));
      assert.equal(code, 2, output);
      assert.match(output, /^Usage: node scripts\/node-test\.ts unit\|integration /);
    }
  });

  it(
    "passes SIGTERM on to the test runner and exits with its code",
    { skip: process.platform === "win32" && "Windows has no signals to pass on" },
    async () => {
      const child = startScript("unit", path.join(fixtures, "waiting-test.mjs"));
      const result = finished(child);
      let seen = "";
      let runner: number | undefined;
      for await (const chunk of child.stdout ?? []) {
        seen += String(chunk);
        const match = /RUNNER (\d+)/.exec(seen);
        if (match !== null) {
          runner = Number(match[1]);
          break;
        }
      }
      assert.ok(runner !== undefined, `no RUNNER line in: ${seen}`);
      assert.notEqual(runner, child.pid);
      const signalled = Date.now();
      child.kill("SIGTERM");
      // The test runner ends its files on SIGTERM and exits 1. Without the signal it would run on
      // until the fixture's test ends or reaches its limit, 30 s or more later.
      const { code, signal, output } = await result;
      const elapsed = Date.now() - signalled;
      assert.deepEqual({ code, signal }, { code: 1, signal: null }, output);
      assert.ok(elapsed < 15_000, `the script ended ${elapsed} ms after SIGTERM`);
      for (let waited = 0; isRunning(runner) && waited < 5000; waited += 100) {
        await sleep(100);
      }
      assert.equal(isRunning(runner), false, "the test runner is still running");
    },
  );
});
