// The CI gate of release.yml (`scripts/release-gate-ci.ts`) against a fake GitHub client and a fake
// clock: which runs count, when the gate dispatches ci.yml, ci-all-os.yml, hardhat-versions.yml
// and sdk-floors.yml, and when it gives up. Runs in
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
  retriesFailure,
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

const onePassedJob = { jobs: [{ name: "Floors", conclusion: "success" }] };

interface World {
  linux: Run[];
  allOs: Run[];
  /** hardhat-versions.yml; a passed run 40 unless a test sets it. */
  hardhat?: Run[];
  /** sdk-floors.yml; a passed run 50 unless a test sets it. */
  floors?: Run[];
  jobs: Record<number, unknown>;
}

/** The World field that holds the runs of a workflow other than ci-all-os.yml. */
const FIELD = {
  "ci.yml": "linux",
  "hardhat-versions.yml": "hardhat",
  "sdk-floors.yml": "floors",
} as const;

/** A fake client over a world that `onDispatch` and `onSleep` may change between looks. */
function fake(world: World, onDispatch: (world: World, workflow: string) => void = () => {}) {
  const dispatched: string[] = [];
  world.hardhat ??= [{ id: 40 }];
  world.floors ??= [{ id: 50 }];
  // Runs 40 to 69 belong to hardhat-versions.yml and sdk-floors.yml: one passed job unless a test
  // sets their jobs.
  for (let id = 40; id < 70; id += 1) {
    world.jobs[id] ??= onePassedJob;
  }
  const github: GateGitHub = {
    get: async (apiPath) => {
      const runs = apiPath.includes("/ci.yml/")
        ? world.linux
        : apiPath.includes("/ci-all-os.yml/")
          ? world.allOs
          : apiPath.includes("/hardhat-versions.yml/")
            ? world.hardhat
            : apiPath.includes("/sdk-floors.yml/")
              ? world.floors
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
      onDispatch(world, workflow);
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
  it("passes when all four workflows passed on the commit, without dispatching", async () => {
    const { github, dispatched } = fake({
      linux: [{ id: 10 }],
      allOs: [{ id: 20 }],
      jobs: { 20: passedJobs },
    });
    const result = await gate(input(), github, clock());
    assert.equal(result.ok, true, result.lines.join("\n"));
    assert.deepEqual(dispatched, []);
    assert.match(result.lines.join("\n"), /ci-all-os\.yml: run \[20\]\(.+\) passed/);
    assert.match(result.lines.join("\n"), /hardhat-versions\.yml: run \[40\]\(.+\) passed/);
    assert.match(result.lines.join("\n"), /sdk-floors\.yml: run \[50\]\(.+\) passed/);
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
    const time = clock();
    const result = await gate(input(), github, time);
    assert.equal(result.ok, false);
    assert.deepEqual(dispatched, [`ci-all-os.yml@${TAG}`]);
    // It fails on the first look after the dispatched run failed, not at the deadline.
    assert.equal(time.slept, 1);
    assert.match(result.lines.join("\n"), /the newest run on this commit, \[21\]/);
    assert.match(result.lines.join("\n"), /re-run its failed jobs if the failure is a flake/);
  });

  it("after a dispatch, an older failed run does not end the wait for the dispatched run", async () => {
    let step = 0;
    const world: World = {
      linux: [{ id: 10 }],
      allOs: [{ id: 20, event: "schedule" }],
      jobs: { 20: failedJobs, 21: passedJobs },
    };
    const { github, dispatched } = fake(world);
    const time = clock(() => {
      step += 1;
      // The dispatched run is not listed yet on the first look after the dispatch, is queued on
      // the second, and has passed on the third. The failed run 20 stays listed throughout.
      if (step === 2) {
        world.allOs = [
          { id: 21, event: "workflow_dispatch", status: "queued", conclusion: null },
          { id: 20, event: "schedule" },
        ];
      } else if (step === 3) {
        world.allOs = [
          { id: 21, event: "workflow_dispatch" },
          { id: 20, event: "schedule" },
        ];
      }
    });
    const result = await gate(input(), github, time);
    assert.equal(result.ok, true, result.lines.join("\n"));
    assert.deepEqual(dispatched, [`ci-all-os.yml@${TAG}`]);
    assert.equal(time.slept, 3);
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

  it("counts a successful ci.yml run without reading its jobs, which skip by design", async () => {
    // The fake fails on a GET of jobs it has none for, and run 10 has none.
    const { github, dispatched } = fake({
      linux: [{ id: 10, event: "workflow_dispatch" }],
      allOs: [{ id: 20 }],
      jobs: { 20: passedJobs },
    });
    const result = await gate(input(), github, clock());
    assert.equal(result.ok, true, result.lines.join("\n"));
    assert.deepEqual(dispatched, []);
    assert.match(result.lines.join("\n"), /ci\.yml: run \[10\]\(.+\) passed/);
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
    const { github, dispatched } = fake({
      linux: [],
      allOs: [],
      hardhat: [{ id: 40, conclusion: "failure" }],
      floors: [],
      jobs: {},
    });
    const time = clock();
    const result = await gate(input({ mode: "report" }), github, time);
    assert.equal(result.ok, true);
    assert.deepEqual(dispatched, []);
    assert.equal(time.slept, 0);
    assert.deepEqual(result.lines.slice(1), [
      "ci.yml: no run on this commit, pull-request runs aside.",
      "ci-all-os.yml: no run on this commit, pull-request runs aside.",
      "hardhat-versions.yml: the newest run on this commit, [40](https://github.com/owner/repo/actions/runs/40), did not pass (failure).",
      "sdk-floors.yml: no run on this commit, pull-request runs aside.",
      `A release run would dispatch ci.yml on ${TAG} and wait for it.`,
      `A release run would dispatch ci-all-os.yml on ${TAG} and wait for it.`,
      `A release run would dispatch hardhat-versions.yml on ${TAG} and wait for it.`,
      `A release run would dispatch sdk-floors.yml on ${TAG} and wait for it.`,
    ]);
  });
});

// ci.yml, hardhat-versions.yml and sdk-floors.yml count a run that concluded `success`; the last
// two also require every job to have passed. The gate dispatches each when the commit has no run;
// it dispatches the last two again after a failed run, and never ci.yml.
for (const workflow of ["ci.yml", "hardhat-versions.yml", "sdk-floors.yml"] as const) {
  const field = FIELD[workflow];
  const retries = retriesFailure(workflow);
  /** The runs before the dispatch: a failed one where the gate retries, else none. */
  const before: Run[] = retries ? [{ id: 60, conclusion: "failure" }] : [];
  const other = workflow === "hardhat-versions.yml" ? "sdk-floors.yml" : "hardhat-versions.yml";
  /** A world where every workflow but `workflow` passed, and `workflow` has the given runs. */
  const worldWith = (runs: Run[]): World => ({
    linux: [{ id: 10 }],
    allOs: [{ id: 20 }],
    jobs: { 20: passedJobs },
    [field]: runs,
  });

  describe(`gate and ${workflow}`, () => {
    it("passes on a passed run, without dispatching", async () => {
      const { github, dispatched } = fake(worldWith([{ id: 60, event: "schedule" }]));
      const result = await gate(input(), github, clock());
      assert.equal(result.ok, true, result.lines.join("\n"));
      assert.deepEqual(dispatched, []);
      assert.match(result.lines.join("\n"), new RegExp(`${workflow}: run \\[60\\]\\(.+\\) passed`));
    });

    it("dispatches it on the tag when no run exists, then waits for the dispatched run", async () => {
      let step = 0;
      const world = worldWith([]);
      const { github, dispatched } = fake(world);
      const time = clock(() => {
        step += 1;
        if (step === 1) {
          world[field] = [
            { id: 61, event: "workflow_dispatch", status: "queued", conclusion: null },
          ];
        } else if (step === 2) {
          world[field] = [{ id: 61, event: "workflow_dispatch" }];
        }
      });
      const result = await gate(input(), github, time);
      assert.equal(result.ok, true, result.lines.join("\n"));
      assert.deepEqual(dispatched, [`${workflow}@${TAG}`]);
      assert.equal(time.slept, 2);
    });

    it("does not count a pull-request run on the same commit, and dispatches", async () => {
      const world = worldWith([{ id: 60, event: "pull_request" }]);
      const { github, dispatched } = fake(world, (changed) => {
        changed[field] = [{ id: 61, event: "workflow_dispatch" }, ...(changed[field] ?? [])];
      });
      const result = await gate(input(), github, clock());
      assert.equal(result.ok, true, result.lines.join("\n"));
      assert.deepEqual(dispatched, [`${workflow}@${TAG}`]);
      assert.match(result.lines.join("\n"), new RegExp(`${workflow}: run \\[61\\]`));
    });

    for (const conclusion of retries ? ["cancelled", "skipped"] : []) {
      it(`does not count a ${conclusion} run, and dispatches`, async () => {
        const world = worldWith([{ id: 60, conclusion }]);
        const { github, dispatched } = fake(world, (changed) => {
          changed[field] = [{ id: 61, event: "workflow_dispatch" }, ...(changed[field] ?? [])];
        });
        const result = await gate(input(), github, clock());
        assert.equal(result.ok, true, result.lines.join("\n"));
        assert.deepEqual(dispatched, [`${workflow}@${TAG}`]);
        assert.match(
          result.lines.join("\n"),
          new RegExp(`${workflow}: run \\[61\\]\\(.+\\) passed`),
        );
      });
    }

    // ci.yml is read without its jobs; "counts a successful ci.yml run without reading its jobs"
    // covers it.
    if (workflow !== "ci.yml") {
      it("does not count a successful run with a skipped job or with no job", async () => {
        for (const jobs of [
          { jobs: [{ name: "Floors", conclusion: "skipped" }] },
          {
            jobs: [
              { name: "Floors", conclusion: "success" },
              { name: "Floors, later", conclusion: "skipped" },
            ],
          },
          { jobs: [] },
        ]) {
          const world = worldWith([{ id: 60 }]);
          world.jobs[60] = jobs;
          const { github, dispatched } = fake(world, (changed) => {
            changed[field] = [{ id: 61, event: "workflow_dispatch" }, ...(changed[field] ?? [])];
          });
          const result = await gate(input(), github, clock());
          assert.equal(result.ok, true, result.lines.join("\n"));
          assert.deepEqual(dispatched, [`${workflow}@${TAG}`]);
          assert.match(
            result.lines.join("\n"),
            new RegExp(`${workflow}: run \\[61\\]\\(.+\\) passed`),
          );
        }
      });
    }

    it("says a dispatched run is not listed yet when it gives up before the run shows", async () => {
      // With no wait it gives up on the look that dispatched; with two minutes, two looks later.
      for (const minutes of [0, 2]) {
        const world = worldWith(before);
        const { github, dispatched } = fake(world);
        const result = await gate(input({ waitMs: minutes * 60_000 }), github, clock());
        assert.equal(result.ok, false);
        assert.deepEqual(dispatched, [`${workflow}@${TAG}`]);
        const text = result.lines.join("\n");
        assert.match(
          text,
          new RegExp(`${workflow}: dispatched on ${TAG}; its run is not listed yet\\.`),
        );
        assert.match(text, new RegExp(`Gave up after ${minutes} minutes`));
      }
    });

    it("waits for a run in progress without dispatching", async () => {
      const world = worldWith([{ id: 60, status: "in_progress", conclusion: null }]);
      const { github, dispatched } = fake(world);
      const time = clock(() => {
        world[field] = [{ id: 60 }];
      });
      const result = await gate(input(), github, time);
      assert.equal(result.ok, true, result.lines.join("\n"));
      assert.deepEqual(dispatched, []);
      assert.equal(time.slept, 1);
    });

    it(`dispatches once ${retries ? "after a failed run" : "when no run exists"}, and fails when the dispatched run fails`, async () => {
      const world = worldWith(before);
      const { github, dispatched } = fake(world, (changed) => {
        changed[field] = [
          { id: 61, event: "workflow_dispatch", conclusion: "failure" },
          ...(changed[field] ?? []),
        ];
      });
      const time = clock();
      const result = await gate(input(), github, time);
      assert.equal(result.ok, false);
      assert.deepEqual(dispatched, [`${workflow}@${TAG}`]);
      assert.equal(time.slept, 1);
      const text = result.lines.join("\n");
      assert.match(text, new RegExp(`${workflow}: the newest run on this commit, \\[61\\]`));
      assert.match(text, new RegExp(`The ${workflow} run dispatched on ${TAG} did not pass`));
      assert.doesNotMatch(text, new RegExp(`The ${other} run dispatched`));
    });

    // Only where the gate dispatches after a failed run.
    if (retries) {
      it("after a dispatch, an older failed run does not end the wait for the dispatched run", async () => {
        let step = 0;
        const world = worldWith([{ id: 60, event: "schedule", conclusion: "failure" }]);
        const { github, dispatched } = fake(world);
        const time = clock(() => {
          step += 1;
          // The dispatched run is not listed on the first look after the dispatch, is queued on the
          // second, and has passed on the third. The failed run 60 stays listed throughout.
          if (step === 2) {
            world[field] = [
              { id: 61, event: "workflow_dispatch", status: "queued", conclusion: null },
              { id: 60, event: "schedule", conclusion: "failure" },
            ];
          } else if (step === 3) {
            world[field] = [
              { id: 61, event: "workflow_dispatch" },
              { id: 60, event: "schedule", conclusion: "failure" },
            ];
          }
        });
        const result = await gate(input(), github, time);
        assert.equal(result.ok, true, result.lines.join("\n"));
        assert.deepEqual(dispatched, [`${workflow}@${TAG}`]);
        assert.equal(time.slept, 3);
      });
    }
  });
}

describe("gate and a ci.yml run that did not pass", () => {
  for (const conclusion of ["failure", "cancelled", "skipped"]) {
    it(`ends at once on a ${conclusion} ci.yml run, and dispatches nothing`, async () => {
      const { github, dispatched } = fake({
        linux: [{ id: 10, conclusion }],
        allOs: [],
        hardhat: [],
        floors: [],
        jobs: {},
      });
      const time = clock();
      const result = await gate(input(), github, time);
      assert.equal(result.ok, false);
      assert.deepEqual(dispatched, []);
      assert.equal(time.slept, 0);
      const text = result.lines.join("\n");
      assert.match(text, /ci\.yml: the newest run on this commit, \[10\]/);
      assert.match(
        text,
        /The newest ci\.yml run on this commit did not pass, and the gate does not retry it\./,
      );
    });
  }

  it("in report mode says a release run would fail, not that it would dispatch ci.yml", async () => {
    const { github, dispatched } = fake({
      linux: [{ id: 10, conclusion: "failure" }],
      allOs: [{ id: 20 }],
      jobs: { 20: passedJobs },
    });
    const result = await gate(input({ mode: "report" }), github, clock());
    assert.equal(result.ok, true);
    assert.deepEqual(dispatched, []);
    const text = result.lines.join("\n");
    assert.match(
      text,
      /A release run would fail: the newest ci\.yml run on this commit did not pass, and the gate does not retry it\./,
    );
    assert.doesNotMatch(text, /would dispatch ci\.yml/);
  });

  it("retries the other three workflows and never ci.yml", () => {
    assert.equal(retriesFailure("ci.yml"), false);
    for (const workflow of ["ci-all-os.yml", "hardhat-versions.yml", "sdk-floors.yml"] as const) {
      assert.equal(retriesFailure(workflow), true);
    }
  });
});

describe("gate with several workflows missing", () => {
  it("dispatches each missing workflow once and passes when all dispatched runs pass", async () => {
    const world: World = {
      linux: [],
      allOs: [],
      hardhat: [],
      floors: [],
      jobs: { 21: passedJobs },
    };
    const { github, dispatched } = fake(world, (changed, workflow) => {
      if (workflow === "ci.yml") {
        changed.linux = [{ id: 11, event: "workflow_dispatch" }];
      } else if (workflow === "hardhat-versions.yml" || workflow === "sdk-floors.yml") {
        changed[FIELD[workflow]] = [{ id: 61, event: "workflow_dispatch" }];
      } else {
        changed.allOs = [{ id: 21, event: "workflow_dispatch" }];
      }
    });
    const time = clock();
    const result = await gate(input(), github, time);
    assert.equal(result.ok, true, result.lines.join("\n"));
    assert.deepEqual(dispatched, [
      `ci.yml@${TAG}`,
      `ci-all-os.yml@${TAG}`,
      `hardhat-versions.yml@${TAG}`,
      `sdk-floors.yml@${TAG}`,
    ]);
    assert.equal(time.slept, 1);
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
