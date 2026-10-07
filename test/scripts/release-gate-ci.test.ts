// The CI gate of release.yml (`scripts/release-gate-ci.ts`) against a fake GitHub client and a fake
// clock: which runs count, when the gate dispatches ci-all-os.yml, and when it gives up. Runs in
// `pnpm test`, with no token and no network.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type Clock,
  type Exec,
  gate,
  gateCandidates,
  gateClient,
  type GateGitHub,
  type GateInput,
  parseGateRuns,
} from "../../scripts/release-gate-ci.ts";

const REPO = "owner/repo";
const SHA = "1111111111111111111111111111111111111111";
const OTHER = "2222222222222222222222222222222222222222";
const TAG = "v1.2.0";

interface Run {
  id: number;
  event?: string;
  head_sha?: string;
  status?: string;
  conclusion?: string | null;
}

const run = (fields: Run): Required<Run> & { html_url: string } => ({
  event: "push",
  head_sha: SHA,
  status: "completed",
  conclusion: "success",
  html_url: `https://github.com/owner/repo/actions/runs/${fields.id}`,
  ...fields,
});

const passedJobs = {
  jobs: [
    { name: "Decide", conclusion: "success" },
    { name: "Test (macOS, Node 22.13.0)", conclusion: "success" },
    { name: "Test (Windows, Node 22.13.0)", conclusion: "success" },
  ],
};
const failedJobs = {
  jobs: [
    { name: "Test (macOS, Node 22.13.0)", conclusion: "success" },
    { name: "Test (Windows, Node 22.13.0)", conclusion: "failure" },
  ],
};

interface World {
  linux: Run[];
  allOs: Run[];
  jobs: Record<number, unknown>;
}

/** A fake client over a world that `onDispatch` and `onSleep` may change between looks. */
function fake(world: World, onDispatch: (world: World) => void = () => {}) {
  const dispatched: string[] = [];
  const github: GateGitHub = {
    get: async (apiPath) => {
      const runs = apiPath.includes("/ci.yml/")
        ? world.linux
        : apiPath.includes("/ci-all-os.yml/")
          ? world.allOs
          : undefined;
      if (runs !== undefined) {
        assert.ok(apiPath.includes(`head_sha=${SHA}`), apiPath);
        return { workflow_runs: runs.map(run) };
      }
      const id = /runs\/(\d+)\/jobs/.exec(apiPath)?.[1];
      const jobs = id === undefined ? undefined : world.jobs[Number(id)];
      assert.ok(jobs !== undefined, `unexpected GET ${apiPath}`);
      return jobs;
    },
    dispatch: async (workflow, ref) => {
      dispatched.push(`${workflow}@${ref}`);
      onDispatch(world);
    },
  };
  return { github, dispatched };
}

function clock(onSleep: () => void = () => {}): Clock & { slept: number } {
  let now = 0;
  const value = {
    slept: 0,
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
      value.slept += 1;
      onSleep();
    },
  };
  return value;
}

const input = (fields: Partial<GateInput> = {}): GateInput => ({
  repo: REPO,
  sha: SHA,
  ref: TAG,
  mode: "enforce",
  waitMs: 10 * 60_000,
  pollMs: 60_000,
  ...fields,
});

describe("parseGateRuns and gateCandidates", () => {
  it("keep push and dispatch runs of the exact commit, never pull-request runs", () => {
    const runs = parseGateRuns({
      workflow_runs: [
        run({ id: 1, event: "pull_request" }),
        run({ id: 2, head_sha: OTHER }),
        run({ id: 3 }),
        run({ id: 4, event: "workflow_dispatch", status: "in_progress", conclusion: null }),
      ],
    });
    assert.deepEqual(
      gateCandidates(runs, SHA).map((candidate) => candidate.id),
      [3, 4],
    );
  });

  it("fail on a response that is not a run list", () => {
    assert.throws(() => parseGateRuns({}), {
      message: "workflow runs: field workflow_runs is not a list",
    });
    assert.throws(() => parseGateRuns({ workflow_runs: [{ id: "1" }] }), {
      message: "workflow run 0: field id is not an integer",
    });
  });
});

describe("gate", () => {
  it("passes when ci.yml and ci-all-os.yml both passed on the commit, without dispatching", async () => {
    const { github, dispatched } = fake({
      linux: [{ id: 10 }],
      allOs: [{ id: 20 }],
      jobs: { 20: passedJobs },
    });
    const result = await gate(input(), github, clock());
    assert.equal(result.ok, true, result.lines.join("\n"));
    assert.deepEqual(dispatched, []);
    assert.match(result.lines.join("\n"), /ci-all-os\.yml: run \[20\]\(.+\) passed/);
  });

  it("does not count an all-OS run whose test jobs were skipped", async () => {
    const skipped = {
      jobs: [
        { name: "Test (macOS, Node 22.13.0)", conclusion: "skipped" },
        { name: "Test (Windows, Node 22.13.0)", conclusion: "skipped" },
      ],
    };
    const { github, dispatched } = fake(
      { linux: [{ id: 10 }], allOs: [{ id: 20 }], jobs: { 20: skipped, 21: passedJobs } },
      (world) => {
        world.allOs.unshift({ id: 21, event: "workflow_dispatch" });
      },
    );
    const result = await gate(input(), github, clock());
    assert.equal(result.ok, true, result.lines.join("\n"));
    assert.deepEqual(dispatched, [`ci-all-os.yml@${TAG}`]);
  });

  it("dispatches ci-all-os.yml on the tag when no run exists, then waits for it", async () => {
    let step = 0;
    const world: World = { linux: [{ id: 10 }], allOs: [], jobs: { 30: passedJobs } };
    const { github, dispatched } = fake(world);
    const result = await gate(
      input(),
      github,
      clock(() => {
        step += 1;
        // The dispatched run shows up after one look, runs for one more, then passes.
        if (step === 1) {
          world.allOs = [
            { id: 30, event: "workflow_dispatch", status: "queued", conclusion: null },
          ];
        } else if (step === 2) {
          world.allOs = [{ id: 30, event: "workflow_dispatch" }];
        }
      }),
    );
    assert.equal(result.ok, true, result.lines.join("\n"));
    assert.deepEqual(dispatched, [`ci-all-os.yml@${TAG}`]);
  });

  it("dispatches once when the only all-OS run failed, and fails when the new run fails too", async () => {
    const world: World = {
      linux: [{ id: 10 }],
      allOs: [{ id: 20 }],
      jobs: { 20: failedJobs, 21: failedJobs },
    };
    const { github, dispatched } = fake(world, (changed) => {
      changed.allOs.unshift({ id: 21, event: "workflow_dispatch" });
    });
    const result = await gate(input(), github, clock());
    assert.equal(result.ok, false);
    assert.deepEqual(dispatched, [`ci-all-os.yml@${TAG}`]);
    assert.match(result.lines.join("\n"), /the newest run on this commit, \[21\]/);
  });

  it("waits for a ci.yml run in progress", async () => {
    const world: World = {
      linux: [{ id: 10, status: "in_progress", conclusion: null }],
      allOs: [{ id: 20 }],
      jobs: { 20: passedJobs },
    };
    const { github } = fake(world);
    const time = clock(() => {
      world.linux = [{ id: 10 }];
    });
    const result = await gate(input(), github, time);
    assert.equal(result.ok, true, result.lines.join("\n"));
    assert.equal(time.slept, 1);
  });

  it("fails at once when ci.yml has no passing run on the commit, and dispatches nothing", async () => {
    for (const linux of [[], [{ id: 10, conclusion: "failure" }]]) {
      const { github, dispatched } = fake({ linux, allOs: [], jobs: {} });
      const result = await gate(input(), github, clock());
      assert.equal(result.ok, false);
      assert.deepEqual(dispatched, []);
      assert.match(result.lines.join("\n"), /Without a passing ci\.yml run/);
    }
  });

  it("gives up when the runs do not finish within the wait", async () => {
    const { github } = fake({
      linux: [{ id: 10 }],
      allOs: [{ id: 20, status: "in_progress", conclusion: null }],
      jobs: {},
    });
    const result = await gate(input({ waitMs: 3 * 60_000 }), github, clock());
    assert.equal(result.ok, false);
    assert.match(result.lines.join("\n"), /Gave up after 3 minutes/);
  });

  it("in report mode looks once, dispatches nothing and passes, saying what a release would do", async () => {
    const { github, dispatched } = fake({ linux: [], allOs: [], jobs: {} });
    const time = clock();
    const result = await gate(input({ mode: "report" }), github, time);
    assert.equal(result.ok, true);
    assert.deepEqual(dispatched, []);
    assert.equal(time.slept, 0);
    assert.deepEqual(result.lines.slice(1), [
      "ci.yml: no push or dispatch run on this commit.",
      "ci-all-os.yml: no push or dispatch run on this commit.",
      `A release run would dispatch ci-all-os.yml on ${TAG} and wait for it.`,
    ]);
  });
});

const failingExec: Exec = async () => {
  throw Object.assign(new Error("exit 1"), { stderr: "HTTP 403: Resource not accessible\n" });
};

describe("gateClient", () => {
  it("dispatches with POST and accepts the empty 204 body", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (file, args) => {
      calls.push([file, ...args]);
      return { stdout: "" };
    };
    await gateClient(REPO, exec).dispatch("ci-all-os.yml", TAG);
    assert.deepEqual(calls, [
      [
        "gh",
        "api",
        "--method",
        "POST",
        `repos/${REPO}/actions/workflows/ci-all-os.yml/dispatches`,
        "-f",
        `ref=${TAG}`,
      ],
    ]);
  });

  it("names the call and gh's error when the API fails", async () => {
    await assert.rejects(gateClient(REPO, failingExec).get("repos/x"), {
      message: "gh api repos/x failed: HTTP 403: Resource not accessible",
    });
  });
});
