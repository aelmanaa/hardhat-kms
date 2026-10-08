// The CI gate of release.yml (`scripts/release-gate-ci.ts`) against a fake GitHub client and a fake
// clock: which runs count, when the gate dispatches ci.yml, ci-all-os.yml, hardhat-versions.yml
// and sdk-floors.yml, and when it gives up. Runs in
// `pnpm test`, with no token and no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  annotation,
  annotations,
  type Clock,
  describeFailures,
  DISPATCHED_WORKFLOWS,
  type Exec,
  gate,
  gateCandidates,
  gateClient,
  type GateGitHub,
  type GateInput,
  parseGateRuns,
  RETRY_RULES,
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
  run_attempt?: number;
}

const run = (fields: Run): Required<Run> & { html_url: string } => ({
  event: "push",
  head_sha: SHA,
  status: "completed",
  conclusion: "success",
  html_url: `https://github.com/owner/repo/actions/runs/${fields.id}`,
  run_attempt: 1,
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
  /** The jobs of a run's newest attempt, by run id. */
  jobs: Record<number, unknown>;
  /** Earlier attempts of a re-run run, by `<run id>/<attempt>`. */
  attempts?: Record<string, { conclusion: string; jobs: unknown }>;
}

/** The jobs a failed run has unless a test sets them. */
const oneFailedJob = { jobs: [{ name: "Job", conclusion: "failure" }] };

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
  const find = (id: number): Run | undefined =>
    [world.linux, world.allOs, world.hardhat ?? [], world.floors ?? []]
      .flat()
      .find((listed) => listed.id === id);
  // A run's jobs unless a test sets them: one failed job for a run that did not conclude
  // `success`, and one passed job for runs 40 to 69, which belong to hardhat-versions.yml and
  // sdk-floors.yml. Other runs have none, so a GET of their jobs fails the test.
  const jobsOf = (id: number): unknown => {
    const listed = find(id);
    if (world.jobs[id] !== undefined) {
      return world.jobs[id];
    }
    if (listed !== undefined && (listed.conclusion ?? "success") !== "success") {
      return oneFailedJob;
    }
    return id >= 40 && id < 70 ? onePassedJob : undefined;
  };
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
      const attempt = /runs\/(\d+)\/attempts\/(\d+)(\/jobs)?/.exec(apiPath);
      if (attempt !== null) {
        const id = Number(attempt[1]);
        const number = Number(attempt[2]);
        const listed = find(id);
        assert.ok(listed !== undefined, `unexpected GET ${apiPath}`);
        if (number === (listed.run_attempt ?? 1)) {
          assert.ok(attempt[3] !== undefined, `unexpected GET ${apiPath}`);
          const jobs = jobsOf(id);
          assert.ok(jobs !== undefined, `unexpected GET ${apiPath}`);
          return jobs;
        }
        const earlier = world.attempts?.[`${id}/${number}`];
        assert.ok(earlier !== undefined, `unexpected GET ${apiPath}`);
        return attempt[3] === undefined
          ? run({ ...listed, run_attempt: number, conclusion: earlier.conclusion })
          : earlier.jobs;
      }
      const id = /runs\/(\d+)\/jobs/.exec(apiPath)?.[1];
      const jobs = id === undefined ? undefined : jobsOf(Number(id));
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
      [
        "Failed runs on this commit, pull-request runs aside. A later pass does not erase them: read each one, and decide whether it was a flake, before approving `npm-publish`.",
        "- hardhat-versions.yml: run [40](https://github.com/owner/repo/actions/runs/40), attempt 1 of 1, concluded failure. Failed jobs: Job (failure).",
      ].join("\n"),
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
  for (const conclusion of ["failure", "skipped"]) {
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

  it("dispatches ci.yml after a cancelled run, which tested nothing", async () => {
    const { github, dispatched } = fake(
      {
        linux: [{ id: 10, conclusion: "cancelled" }],
        allOs: [{ id: 20 }],
        jobs: { 20: passedJobs },
      },
      (changed) => {
        changed.linux = [{ id: 11, event: "workflow_dispatch" }, ...changed.linux];
      },
    );
    const result = await gate(input(), github, clock());
    assert.equal(result.ok, true, result.lines.join("\n"));
    assert.deepEqual(dispatched, [`ci.yml@${TAG}`]);
    assert.match(
      result.lines.join("\n"),
      /- ci\.yml: run \[10\]\(.+\), attempt 1 of 1, concluded cancelled\./,
    );
  });

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

  it("retries ci-all-os.yml and hardhat-versions.yml, never ci.yml or sdk-floors.yml", () => {
    assert.equal(retriesFailure("ci.yml"), false);
    assert.equal(retriesFailure("ci-all-os.yml"), true);
    assert.equal(retriesFailure("hardhat-versions.yml"), true);
    assert.equal(retriesFailure("sdk-floors.yml"), false);
  });

  it("matches the retry table in releasing.md, row for row", () => {
    const page = readFileSync(
      fileURLToPath(new URL("../../docs/contributor/releasing.md", import.meta.url)),
      "utf8",
    );
    const rows = [...page.matchAll(/^ *\| `([a-z-]+\.yml)` *\|([^|]+)\|([^|]+)\|([^|]+)\|$/gm)].map(
      (match) => [match[1], match[2]?.trim(), match[3]?.trim(), match[4]?.trim()],
    );
    assert.match(
      page,
      /^ *\| Workflow +\| No run, or not fully tested \| The newest run failed \| Why +\|$/m,
    );
    assert.deepEqual(
      rows,
      DISPATCHED_WORKFLOWS.map((workflow) => [
        workflow,
        "Dispatch once",
        RETRY_RULES[workflow].retriesFailure ? "Dispatch once more" : "Stop the gate",
        RETRY_RULES[workflow].why,
      ]),
    );
  });
});

// The retry rule for each workflow, and the failure list that ends every summary.
const ALL_FIELDS = { ...FIELD, "ci-all-os.yml": "allOs" } as const;
for (const workflow of DISPATCHED_WORKFLOWS) {
  const field = ALL_FIELDS[workflow];
  const retries = retriesFailure(workflow);
  /** Passed jobs for a run of `workflow` that passed; ci.yml's are never read. */
  const passing = workflow === "ci-all-os.yml" ? passedJobs : onePassedJob;
  /** A world where every workflow but `workflow` passed, and `workflow` has the given runs. */
  const worldWith = (runs: Run[]): World => {
    const world: World = {
      linux: [{ id: 10 }],
      allOs: [{ id: 20 }],
      jobs: { 20: passedJobs, 71: passing, 72: passing },
    };
    world[field] = runs;
    return world;
  };
  /** A failed run's jobs: one failed, one passed, one skipped; only the first is listed. */
  const buildFailed = {
    jobs: [
      { name: "Build", conclusion: "failure" },
      { name: "Lint", conclusion: "success" },
      { name: "Docs", conclusion: "skipped" },
    ],
  };
  const earlier = new RegExp(
    `- ${workflow.replace(".", "\\.")}: run \\[70\\]\\(.+\\), attempt 1 of 1, concluded failure\\. Failed jobs: Build \\(failure\\)\\.`,
  );

  describe(`the retry rule and the failure list for ${workflow}`, () => {
    it("passes on a passing run after a failed one, and lists the failed run", async () => {
      const world = worldWith([
        { id: 71, event: "workflow_dispatch" },
        { id: 70, conclusion: "failure" },
      ]);
      world.jobs[70] = buildFailed;
      const { github, dispatched } = fake(world);
      const result = await gate(input(), github, clock());
      assert.equal(result.ok, true, result.lines.join("\n"));
      assert.deepEqual(dispatched, []);
      const text = result.lines.join("\n");
      assert.match(text, new RegExp(`${workflow}: run \\[71\\]\\(.+\\) passed`));
      assert.match(text, earlier);
      assert.deepEqual(
        result.failures.map(({ workflow: name, runId, attempt }) => [name, runId, attempt]),
        [[workflow, 70, 1]],
      );
    });

    it(
      retries
        ? "dispatches once after a failed run, passes on the new run, and still lists the failed one"
        : "stops on a failed run without dispatching, and lists it",
      async () => {
        const world = worldWith([{ id: 70, conclusion: "failure" }]);
        world.jobs[70] = buildFailed;
        const { github, dispatched } = fake(world, (changed) => {
          changed[field] = [{ id: 71, event: "workflow_dispatch" }, ...(changed[field] ?? [])];
        });
        const time = clock();
        const result = await gate(input(), github, time);
        assert.equal(result.ok, retries, result.lines.join("\n"));
        assert.deepEqual(dispatched, retries ? [`${workflow}@${TAG}`] : []);
        assert.equal(time.slept, retries ? 1 : 0);
        const text = result.lines.join("\n");
        assert.match(text, earlier);
        if (!retries) {
          assert.match(
            text,
            new RegExp(
              `The newest ${workflow.replace(".", "\\.")} run on this commit did not pass, and the gate does not retry it\\.`,
            ),
          );
        }
      },
    );

    it("lists a failed earlier attempt of a run that passed on a re-run", async () => {
      const world = worldWith([{ id: 72, run_attempt: 2 }]);
      world.attempts = {
        "72/1": {
          conclusion: "failure",
          jobs: { jobs: [{ name: "Build", conclusion: "timed_out" }] },
        },
      };
      const { github, dispatched } = fake(world);
      const result = await gate(input(), github, clock());
      assert.equal(result.ok, true, result.lines.join("\n"));
      assert.deepEqual(dispatched, []);
      assert.match(
        result.lines.join("\n"),
        new RegExp(
          `- ${workflow.replace(".", "\\.")}: run \\[72\\]\\(https://github\\.com/owner/repo/actions/runs/72/attempts/1\\), attempt 1 of 2, concluded failure\\. Failed jobs: Build \\(timed_out\\)\\.`,
        ),
      );
    });

    it("does not list an earlier attempt that passed", async () => {
      const world = worldWith([{ id: 72, run_attempt: 2 }]);
      world.attempts = { "72/1": { conclusion: "success", jobs: passing } };
      const { github } = fake(world);
      const result = await gate(input(), github, clock());
      assert.equal(result.ok, true, result.lines.join("\n"));
      assert.deepEqual(result.failures, []);
      assert.equal(
        result.lines.at(-1),
        "No run of the four workflows failed on this commit, pull-request runs aside.",
      );
    });

    it("dispatches once when no run exists, as before, and lists no failure", async () => {
      const world = worldWith([]);
      const { github, dispatched } = fake(world, (changed) => {
        changed[field] = [{ id: 71, event: "workflow_dispatch" }];
      });
      const result = await gate(input(), github, clock());
      assert.equal(result.ok, true, result.lines.join("\n"));
      assert.deepEqual(dispatched, [`${workflow}@${TAG}`]);
      assert.deepEqual(result.failures, []);
    });

    it("stops on a failed run dispatched on the commit, so a re-run of the job retries nothing", async () => {
      // Run 73 is the dispatch of an earlier attempt of the gate job; run 70 the run before it.
      const world = worldWith([
        { id: 73, event: "workflow_dispatch", conclusion: "failure" },
        { id: 70, conclusion: "failure" },
      ]);
      world.jobs[70] = buildFailed;
      const { github, dispatched } = fake(world);
      const result = await gate(input(), github, clock());
      assert.equal(result.ok, false, result.lines.join("\n"));
      assert.deepEqual(dispatched, []);
      assert.deepEqual(
        result.failures.map(({ runId }) => runId),
        [73, 70],
      );
    });

    it("dispatches after a cancelled run, as for a missing run, and lists the cancelled run", async () => {
      const world = worldWith([{ id: 70, conclusion: "cancelled" }]);
      world.jobs[70] = {
        jobs: [
          { name: "Build", conclusion: "cancelled" },
          { name: "Lint", conclusion: "success" },
        ],
      };
      const { github, dispatched } = fake(world, (changed) => {
        changed[field] = [{ id: 71, event: "workflow_dispatch" }, ...(changed[field] ?? [])];
      });
      const result = await gate(input(), github, clock());
      assert.equal(result.ok, true, result.lines.join("\n"));
      assert.deepEqual(dispatched, [`${workflow}@${TAG}`]);
      assert.match(
        result.lines.join("\n"),
        new RegExp(
          `- ${workflow.replace(".", "\\.")}: run \\[70\\]\\(.+\\), attempt 1 of 1, concluded cancelled\\. Failed jobs: Build \\(cancelled\\)\\.`,
        ),
      );
    });

    it("stops on a cancelled run dispatched on the commit", async () => {
      const world = worldWith([{ id: 73, event: "workflow_dispatch", conclusion: "cancelled" }]);
      const { github, dispatched } = fake(world);
      const result = await gate(input(), github, clock());
      assert.equal(result.ok, false, result.lines.join("\n"));
      assert.deepEqual(dispatched, []);
      assert.deepEqual(
        result.failures.map(({ runId, conclusion }) => [runId, conclusion]),
        [[73, "cancelled"]],
      );
    });

    // ci.yml is read without its jobs, so it has no run that passed with a skipped job.
    if (workflow !== "ci.yml") {
      const skippedJob =
        workflow === "ci-all-os.yml"
          ? {
              jobs: [
                { name: "Test (macOS, Node 22.13.0)", conclusion: "skipped" },
                { name: "Test (Windows, Node 22.13.0)", conclusion: "skipped" },
              ],
            }
          : { jobs: [{ name: "Floors", conclusion: "skipped" }] };

      it("in report mode says a release would dispatch after a run with a skipped job", async () => {
        const world = worldWith([{ id: 70 }]);
        world.jobs[70] = skippedJob;
        const { github } = fake(world);
        const result = await gate(input({ mode: "report" }), github, clock());
        const text = result.lines.join("\n");
        assert.match(text, /concluded success but skipped a job, so it was not fully tested\./);
        assert.match(
          text,
          new RegExp(`A release run would dispatch ${workflow.replace(".", "\\.")} on`),
        );
        assert.doesNotMatch(text, /A release run would fail/);
      });

      it(`acts on an older failed run, not a newer run with a skipped job: ${retries ? "dispatches" : "stops"}`, async () => {
        const world = worldWith([{ id: 74 }, { id: 70, conclusion: "failure" }]);
        world.jobs[74] = skippedJob;
        world.jobs[70] = buildFailed;
        const { github, dispatched } = fake(world, (changed) => {
          changed[field] = [{ id: 71, event: "workflow_dispatch" }, ...(changed[field] ?? [])];
        });
        const result = await gate(input(), github, clock());
        assert.equal(result.ok, retries, result.lines.join("\n"));
        assert.deepEqual(dispatched, retries ? [`${workflow}@${TAG}`] : []);
        assert.match(result.lines.join("\n"), earlier);
      });
    }

    it("in report mode lists the failed run", async () => {
      const world = worldWith([{ id: 70, conclusion: "failure" }]);
      world.jobs[70] = buildFailed;
      const { github, dispatched } = fake(world);
      const result = await gate(input({ mode: "report" }), github, clock());
      assert.equal(result.ok, true);
      assert.deepEqual(dispatched, []);
      const text = result.lines.join("\n");
      assert.match(text, earlier);
      assert.match(
        text,
        retries
          ? new RegExp(`A release run would dispatch ${workflow.replace(".", "\\.")} on`)
          : new RegExp(`A release run would fail: the newest ${workflow.replace(".", "\\.")} run`),
      );
    });
  });
}

describe("describeFailures and annotation", () => {
  it("says when a failed run has no failed job", () => {
    assert.equal(
      describeFailures([
        {
          workflow: "ci.yml",
          runId: 9,
          attempt: 1,
          attempts: 1,
          conclusion: "startup_failure",
          htmlUrl: "https://github.com/owner/repo/actions/runs/9",
          failedJobs: [],
        },
      ]).split("\n")[1],
      "- ci.yml: run [9](https://github.com/owner/repo/actions/runs/9), attempt 1 of 1, concluded startup_failure. No job failed; the run page shows the cause.",
    );
  });

  it("writes one warning annotation per failure", () => {
    assert.deepEqual(
      annotations([
        {
          workflow: "sdk-floors.yml",
          runId: 9,
          attempt: 1,
          attempts: 2,
          conclusion: "failure",
          htmlUrl: "https://github.com/owner/repo/actions/runs/9/attempts/1",
          failedJobs: ["SDK floors (failure)"],
        },
      ]),
      [
        "::warning title=Failed CI run on the tagged commit::sdk-floors.yml run 9 attempt 1 of 2 concluded failure. https://github.com/owner/repo/actions/runs/9/attempts/1",
      ],
    );
    assert.deepEqual(annotations([]), []);
  });

  it("escapes a workflow-command message", () => {
    assert.equal(annotation("100%\r\nnext"), "100%25%0D%0Anext");
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
