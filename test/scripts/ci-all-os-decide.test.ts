// The decision and the tracking-issue report of ci-all-os.yml (`scripts/ci-all-os-decide.ts`),
// against fixtures trimmed from real API responses of this repository (ids and URLs replaced) and a
// fake GitHub client. Runs in `pnpm test`, with no token and no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  bothPassed,
  decide,
  type Exec,
  type Fields,
  ghClient,
  type GitHub,
  ISSUE_LABELS,
  ISSUE_TITLE,
  parseIssues,
  parseJobs,
  parseRuns,
  planReport,
  report,
} from "../../scripts/ci-all-os-decide.ts";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/ci-all-os");
const fixture = (name: string): unknown => {
  const parsed: unknown = JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
  return parsed;
};

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

const REPO = "owner/repo";
const SHA = "1111111111111111111111111111111111111111";
const RUN_URL = "https://github.com/owner/repo/actions/runs/3001";
const RUNS_PATH = `repos/${REPO}/actions/workflows/ci-all-os.yml/runs?branch=main&head_sha=${SHA}&per_page=100`;
const jobsPath = (id: number): string => `repos/${REPO}/actions/runs/${id}/jobs?per_page=100`;

interface Run {
  id: number;
  head_branch?: string;
  event?: string;
}

/** The real runs fixture, with its one run replaced by these. */
function runsResponse(runs: readonly Run[]): unknown {
  const template = field(fixture("runs.json"), "workflow_runs");
  const first: unknown = Array.isArray(template) ? template[0] : undefined;
  return {
    total_count: runs.length,
    workflow_runs: runs.map((run) => ({
      ...(typeof first === "object" && first !== null ? first : {}),
      html_url: `https://github.com/owner/repo/actions/runs/${run.id}`,
      ...run,
    })),
  };
}

interface Call {
  method: string;
  apiPath: string;
  fields?: Fields;
}

/** A fake client: GET answers from `responses`; an Error value is thrown. Records every call. */
function fakeGitHub(responses: Record<string, unknown>, listPages: unknown[] = []) {
  const calls: Call[] = [];
  let nextIssue = 100;
  const answer = (apiPath: string): unknown => {
    if (!(apiPath in responses)) {
      throw new Error(`unexpected GET ${apiPath}`);
    }
    const response = responses[apiPath];
    if (response instanceof Error) {
      throw response;
    }
    return response;
  };
  const github: GitHub = {
    get: async (apiPath) => {
      calls.push({ method: "GET", apiPath });
      return await Promise.resolve(answer(apiPath));
    },
    list: async (apiPath) => {
      calls.push({ method: "LIST", apiPath });
      return await Promise.resolve(listPages);
    },
    send: async (method, apiPath, fields) => {
      calls.push({ method, apiPath, fields });
      return await Promise.resolve(apiPath.endsWith("/issues") ? { number: nextIssue++ } : {});
    },
  };
  return { github, calls };
}

describe("parsing the API responses", () => {
  it("reads the runs fixture", () => {
    assert.deepEqual(parseRuns(fixture("runs.json")), [
      {
        id: 1001,
        event: "push",
        headBranch: "main",
        headSha: SHA,
        htmlUrl: "https://github.com/owner/repo/actions/runs/1001",
      },
    ]);
  });

  it("reads the jobs fixtures", () => {
    assert.deepEqual(parseJobs(fixture("jobs-fail.json")), [
      { name: "Test (macOS, Node 22.13.0)", conclusion: "success" },
      { name: "Test (Windows, Node 22.13.0)", conclusion: "failure" },
    ]);
    assert.deepEqual(
      parseJobs({ jobs: [{ name: "Test (macOS, Node 22.13.0)", conclusion: null }] }),
      [{ name: "Test (macOS, Node 22.13.0)", conclusion: null }],
    );
  });

  it("drops pull requests from the issue list", () => {
    assert.deepEqual(parseIssues([fixture("issues-page.json")]), [
      { number: 10, title: "Some other issue" },
    ]);
  });

  it("fails on a response it cannot read", () => {
    assert.throws(() => parseRuns({ message: "Not Found" }), /workflow_runs is not a list/);
    assert.throws(() => parseRuns({ workflow_runs: [{ id: "1" }] }), /field id is not an integer/);
    assert.throws(() => parseJobs({ jobs: [{ name: "x", conclusion: 1 }] }), /conclusion/);
    assert.throws(() => parseIssues([{ number: 1 }]), /not a list/);
  });
});

describe("bothPassed", () => {
  it("is true only when the macOS and the Windows job concluded success", () => {
    assert.equal(bothPassed(parseJobs(fixture("jobs-pass.json"))), true);
    assert.equal(bothPassed(parseJobs(fixture("jobs-fail.json"))), false);
    assert.equal(bothPassed(parseJobs(fixture("jobs-skipped.json"))), false);
    assert.equal(
      bothPassed([
        { name: "Test (macOS, Node 22.13.0)", conclusion: "success" },
        { name: "Decide", conclusion: "success" },
      ]),
      false,
    );
    assert.equal(bothPassed([]), false);
  });
});

describe("decide on a schedule", () => {
  const schedule = { repo: REPO, sha: SHA, event: "schedule", dryRun: false, runId: 3001 };

  it("skips when a run on main passed both jobs on this commit, and names that run", async () => {
    const { github } = fakeGitHub({
      [RUNS_PATH]: fixture("runs.json"),
      [jobsPath(1001)]: fixture("jobs-pass.json"),
    });
    const decision = await decide(schedule, github);
    assert.equal(decision.run, false);
    assert.match(decision.summary, new RegExp(SHA));
    assert.match(decision.summary, /skipped/);
    assert.match(
      decision.summary,
      /\[1001\]\(https:\/\/github\.com\/owner\/repo\/actions\/runs\/1001\)/,
    );
  });

  it("runs when the matching run failed one job", async () => {
    const { github } = fakeGitHub({
      [RUNS_PATH]: fixture("runs.json"),
      [jobsPath(1001)]: fixture("jobs-fail.json"),
    });
    const decision = await decide(schedule, github);
    assert.equal(decision.run, true);
    assert.match(decision.summary, /no run of this workflow on `main` passed both/);
  });

  it("runs when the matching run skipped its test jobs (a skip or a dry run is no pass)", async () => {
    const { github } = fakeGitHub({
      [RUNS_PATH]: runsResponse([{ id: 1002, event: "workflow_dispatch" }]),
      [jobsPath(1002)]: fixture("jobs-skipped.json"),
    });
    assert.equal((await decide(schedule, github)).run, true);
  });

  it("runs when no run matches the commit", async () => {
    const { github } = fakeGitHub({ [RUNS_PATH]: runsResponse([]) });
    assert.equal((await decide(schedule, github)).run, true);
  });

  it("ignores runs on another branch, pull request runs and the current run", async () => {
    const { github, calls } = fakeGitHub({
      [RUNS_PATH]: runsResponse([
        { id: 3001, event: "schedule" },
        { id: 1003, head_branch: "feature" },
        { id: 1004, event: "pull_request" },
        { id: 1005, head_branch: "feature", event: "pull_request" },
      ]),
    });
    assert.equal((await decide(schedule, github)).run, true);
    assert.deepEqual(
      calls.map((call) => call.apiPath),
      [RUNS_PATH],
    );
  });

  it("ignores a run of another commit that the API returned", async () => {
    const other = runsResponse([{ id: 1006 }]);
    const runs = field(other, "workflow_runs");
    const run: unknown = Array.isArray(runs) ? runs[0] : undefined;
    assert.ok(typeof run === "object" && run !== null);
    Reflect.set(run, "head_sha", "2222222222222222222222222222222222222222");
    const { github } = fakeGitHub({ [RUNS_PATH]: other });
    assert.equal((await decide(schedule, github)).run, true);
  });

  it("finds an older passing run behind a newer failed one", async () => {
    const { github } = fakeGitHub({
      [RUNS_PATH]: runsResponse([{ id: 1008, event: "schedule" }, { id: 1007 }]),
      [jobsPath(1008)]: fixture("jobs-fail.json"),
      [jobsPath(1007)]: fixture("jobs-pass.json"),
    });
    const decision = await decide(schedule, github);
    assert.equal(decision.run, false);
    assert.match(decision.summary, /\[1007\]/);
  });

  it("fails when the API call fails, and never skips", async () => {
    const runsDown = fakeGitHub({ [RUNS_PATH]: new Error("HTTP 502") });
    await assert.rejects(decide(schedule, runsDown.github), /HTTP 502/);
    const jobsDown = fakeGitHub({
      [RUNS_PATH]: fixture("runs.json"),
      [jobsPath(1001)]: new Error("HTTP 403: Resource not accessible by integration"),
    });
    await assert.rejects(decide(schedule, jobsDown.github), /HTTP 403/);
    const garbled = fakeGitHub({ [RUNS_PATH]: { message: "Not Found" } });
    await assert.rejects(decide(schedule, garbled.github), /workflow_runs/);
  });
});

describe("decide on a manual dispatch", () => {
  it("runs without asking the API", async () => {
    const { github, calls } = fakeGitHub({});
    const decision = await decide(
      { repo: REPO, sha: SHA, event: "workflow_dispatch", dryRun: false },
      github,
    );
    assert.equal(decision.run, true);
    assert.match(decision.summary, /Manual dispatch/);
    assert.deepEqual(calls, []);
  });

  it("with dry-run, runs nothing and says what a nightly run would do", async () => {
    const dryRun = { repo: REPO, sha: SHA, event: "workflow_dispatch", dryRun: true };
    const passed = fakeGitHub({
      [RUNS_PATH]: fixture("runs.json"),
      [jobsPath(1001)]: fixture("jobs-pass.json"),
    });
    const skip = await decide(dryRun, passed.github);
    assert.equal(skip.run, false);
    assert.match(skip.summary, /^Dry run on .*A nightly run would skip .*\[1001\]/);

    const failed = fakeGitHub({
      [RUNS_PATH]: fixture("runs.json"),
      [jobsPath(1001)]: fixture("jobs-fail.json"),
    });
    const run = await decide(dryRun, failed.github);
    assert.equal(run.run, false);
    assert.match(run.summary, /A nightly run would run /);
  });
});

it("decide refuses other events", async () => {
  const { github } = fakeGitHub({});
  await assert.rejects(
    decide({ repo: REPO, sha: SHA, event: "pull_request", dryRun: false }, github),
    /not pull_request/,
  );
});

describe("the tracking issue", () => {
  const tracking = { number: 42, title: ISSUE_TITLE };
  const other = { number: 10, title: "Some other issue" };

  it("a failure opens it with the labels, the commit and the run", () => {
    const action = planReport([other], "failure", SHA, RUN_URL);
    assert.equal(action.kind, "open");
    if (action.kind === "open") {
      assert.equal(action.title, ISSUE_TITLE);
      assert.deepEqual(action.labels, [
        "type:bug",
        "area:ci",
        "status:needs-triage",
        "priority:P1",
      ]);
      assert.match(action.body, new RegExp(SHA));
      assert.match(action.body, new RegExp(RUN_URL));
    }
  });

  it("a second failure comments on the open issue", () => {
    assert.deepEqual(planReport([other, tracking], "failure", SHA, RUN_URL), {
      kind: "comment",
      issue: 42,
      body: `Failed again on ${SHA}: ${RUN_URL}`,
    });
  });

  it("a pass comments on the open issue and closes it", () => {
    assert.deepEqual(planReport([tracking], "success", SHA, RUN_URL), {
      kind: "close",
      issue: 42,
      body: `Passed on ${SHA}: ${RUN_URL}. Closing.`,
    });
  });

  it("a pass with no open issue does nothing", () => {
    assert.deepEqual(planReport([other], "success", SHA, RUN_URL), { kind: "none" });
  });

  it("with two open copies, uses the oldest", () => {
    const action = planReport(
      [{ number: 50, title: ISSUE_TITLE }, tracking],
      "failure",
      SHA,
      RUN_URL,
    );
    assert.equal(action.kind === "comment" ? action.issue : undefined, 42);
  });

  it("report opens, comments and closes through the API", async () => {
    const page = fixture("issues-page.json");

    const first = fakeGitHub({}, [page]);
    assert.equal(await report(first.github, REPO, "failure", SHA, RUN_URL), "Opened issue #100.");
    assert.deepEqual(
      first.calls.map(({ method, apiPath }) => `${method} ${apiPath}`),
      [`LIST repos/${REPO}/issues?state=open&per_page=100`, `POST repos/${REPO}/issues`],
    );
    assert.deepEqual(first.calls[1]?.fields?.["labels"], ISSUE_LABELS);
    assert.equal(first.calls[1]?.fields?.["title"], ISSUE_TITLE);

    const withIssue = [page, [{ number: 42, title: ISSUE_TITLE }]];
    const second = fakeGitHub({}, withIssue);
    assert.equal(
      await report(second.github, REPO, "failure", SHA, RUN_URL),
      "Commented on issue #42.",
    );
    assert.deepEqual(second.calls[1], {
      method: "POST",
      apiPath: `repos/${REPO}/issues/42/comments`,
      fields: { body: `Failed again on ${SHA}: ${RUN_URL}` },
    });

    const pass = fakeGitHub({}, withIssue);
    assert.equal(
      await report(pass.github, REPO, "success", SHA, RUN_URL),
      "Commented on and closed issue #42.",
    );
    assert.deepEqual(
      pass.calls.slice(1).map(({ method, apiPath, fields }) => [method, apiPath, fields]),
      [
        [
          "POST",
          `repos/${REPO}/issues/42/comments`,
          { body: `Passed on ${SHA}: ${RUN_URL}. Closing.` },
        ],
        ["PATCH", `repos/${REPO}/issues/42`, { state: "closed", state_reason: "completed" }],
      ],
    );

    const quiet = fakeGitHub({}, [page]);
    assert.equal(
      await report(quiet.github, REPO, "success", SHA, RUN_URL),
      "No open tracking issue; nothing to do.",
    );
    assert.equal(quiet.calls.length, 1);
  });
});

/** A fake `gh` that answers every call with `stdout` and records the arguments. */
function fakeExec(stdout: string) {
  const calls: (readonly string[])[] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    return await Promise.resolve({ stdout });
  };
  return { exec, calls };
}
/** A `gh` that exits with an HTTP 404, as execFile reports it. */
const failingExec: Exec = async () =>
  await Promise.reject(
    Object.assign(new Error("Command failed"), { stderr: "gh: Not Found (HTTP 404)\n" }),
  );

describe("ghClient", () => {
  it("passes GET, list and send to gh api", async () => {
    const { exec, calls } = fakeExec("[]");
    const github = ghClient(exec);
    await github.get("repos/o/r/actions/runs/1/jobs");
    assert.deepEqual(await github.list("repos/o/r/issues?state=open"), []);
    await github.send("POST", "repos/o/r/issues", {
      title: "T",
      body: "line 1\nline 2",
      labels: ["type:bug", "area:ci"],
    });
    await github.send("PATCH", "repos/o/r/issues/4", { state: "closed" });
    assert.deepEqual(calls, [
      ["gh", "api", "repos/o/r/actions/runs/1/jobs"],
      ["gh", "api", "--paginate", "--slurp", "repos/o/r/issues?state=open"],
      [
        "gh",
        "api",
        "--method",
        "POST",
        "repos/o/r/issues",
        "-f",
        "title=T",
        "-f",
        "body=line 1\nline 2",
        "-f",
        "labels[]=type:bug",
        "-f",
        "labels[]=area:ci",
      ],
      ["gh", "api", "--method", "PATCH", "repos/o/r/issues/4", "-f", "state=closed"],
    ]);
  });

  it("fails with gh's error output when gh fails", async () => {
    await assert.rejects(
      ghClient(failingExec).get("repos/o/r/x"),
      /gh api repos\/o\/r\/x failed: gh: Not Found \(HTTP 404\)$/,
    );
  });

  it("fails when a paginated list is not a list of pages", async () => {
    await assert.rejects(
      ghClient(fakeExec("{}").exec).list("repos/o/r/issues"),
      /not a list of pages/,
    );
  });
});
