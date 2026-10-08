// The CI gate of release.yml. Before anything is published to npm, the tagged commit must have:
// - a run of ci.yml (the Linux jobs) that concluded `success`,
// - a run of ci-all-os.yml whose macOS and Windows test jobs both passed (`bothPassed` of
//   scripts/ci-all-os-decide.ts, so a run whose test jobs were skipped never counts),
// - a run of hardhat-versions.yml (the Hardhat floor and latest), and
// - a run of sdk-floors.yml (the cloud SDK and viem floors),
//   each concluded `success` with every job `success` (`everyJobPassed`), so a run whose jobs
//   were skipped never counts.
// Only runs of that exact commit count, and never pull-request runs: those test a merge commit.
// ci.yml runs on every push to main, so the merge commit of the Version Packages pull request
// usually has one, but a hotfix commit on a release branch has none. The other three are
// path-filtered or scheduled and may have skipped the commit. It waits without dispatching while a
// run is in progress.
//
// The retry rule is RETRY_RULES below, with the same table in docs/contributor/releasing.md (a
// test compares them): every workflow is dispatched once when the commit has no run of it, or only
// a run that was not fully tested (cancelled, or `success` with a skipped job); a failed run is
// dispatched once more only for ci-all-os.yml and hardhat-versions.yml; a run dispatched on the
// commit that did not pass stops the gate, so a re-run of the gate job grants no further retry.
// Whatever the verdict, the output lists every run and every earlier attempt of a run on the
// commit that did not conclude `success`, with its conclusion and failed jobs, so a pass after a
// failure is never silent; the release job also prints each as a warning annotation.
// It talks to the GitHub API through `gh api`, which reads its token from GH_TOKEN.
//
// Usage:
//   node scripts/release-gate-ci.ts --repo OWNER/NAME --sha SHA --ref REF
//     [--mode enforce|report] [--wait-minutes N] [--summary FILE]
// `enforce` (the default) dispatches and waits, and exits 1 unless all four runs passed. `report`
// is the dry run: it looks once, dispatches nothing, writes what it found and exits 0 unless the
// API fails. `--summary` appends the result lines (GITHUB_STEP_SUMMARY).
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

import { bothPassed, type Job, parseJobs } from "./ci-all-os-decide.ts";

/** The Linux workflow, which runs on every push to main and which the gate dispatches when no run passed. */
export const LINUX_WORKFLOW = "ci.yml";
/** The macOS and Windows workflow, which the gate dispatches when no run passed. */
export const ALL_OS_WORKFLOW = "ci-all-os.yml";
/** The Hardhat floor-and-latest workflow, which the gate dispatches when no run passed. */
export const HARDHAT_VERSIONS_WORKFLOW = "hardhat-versions.yml";
/** The SDK and viem floor workflow, which the gate dispatches when no run passed. */
export const SDK_FLOORS_WORKFLOW = "sdk-floors.yml";
/** A workflow the gate dispatches on the tag when the commit has no passing run. */
export type DispatchedWorkflow =
  | typeof LINUX_WORKFLOW
  | typeof ALL_OS_WORKFLOW
  | typeof HARDHAT_VERSIONS_WORKFLOW
  | typeof SDK_FLOORS_WORKFLOW;
/** What the gate does when the newest run of a workflow on the commit failed, and why. */
export interface RetryRule {
  /** Dispatch the workflow once more on the tag; otherwise the failed run ends the gate. */
  retriesFailure: boolean;
  /** The reason, as docs/contributor/releasing.md states it. */
  why: string;
}

/**
 * The retry rule. Every workflow is dispatched once when the commit has no run of it. A failed run
 * is dispatched once more only where the run's result depends on inputs outside the commit, so a
 * second run can test something the first did not; a hermetic workflow would test the same inputs
 * again and only hide a flaky failure.
 */
export const RETRY_RULES: Readonly<Record<DispatchedWorkflow, RetryRule>> = {
  [LINUX_WORKFLOW]: {
    retriesFailure: false,
    why: "hermetic: frozen lockfile, actions and images pinned",
  },
  [ALL_OS_WORKFLOW]: {
    retriesFailure: true,
    why: "runs on macos-latest and windows-latest, and its scheduled run may predate the tag",
  },
  [HARDHAT_VERSIONS_WORKFLOW]: {
    retriesFailure: true,
    why: "tests the latest Hardhat 3 release at run time",
  },
  [SDK_FLOORS_WORKFLOW]: {
    retriesFailure: false,
    why: "hermetic: pinned SDK and viem floors, frozen lockfile",
  },
};

/** Whether the gate dispatches a workflow again when its newest run on the commit failed. */
export function retriesFailure(workflow: DispatchedWorkflow): boolean {
  return RETRY_RULES[workflow].retriesFailure;
}

/** The workflows the gate dispatches, in the order it looks at them and reports them. */
export const DISPATCHED_WORKFLOWS: readonly DispatchedWorkflow[] = [
  LINUX_WORKFLOW,
  ALL_OS_WORKFLOW,
  HARDHAT_VERSIONS_WORKFLOW,
  SDK_FLOORS_WORKFLOW,
];

/** The fields of a workflow run the gate reads. */
export interface GateRun {
  id: number;
  event: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  /** The attempt the run is on: 1, or more after a re-run. */
  attempt: number;
}

/** What the gate found for one workflow. */
export type Found =
  | { state: "passed"; run: GateRun }
  | { state: "pending"; run: GateRun }
  | { state: "failed"; run: GateRun }
  | { state: "missing" };

/** The GitHub calls the gate makes. Tests pass a fake. */
export interface GateGitHub {
  /** GET one page and parse it. */
  get(apiPath: string): Promise<unknown>;
  /** Dispatches a workflow on a ref. */
  dispatch(workflow: string, ref: string): Promise<void>;
}

/** The input of {@link gate}. */
export interface GateInput {
  repo: string;
  sha: string;
  /** The ref a dispatched run checks out: the release tag. */
  ref: string;
  mode: "enforce" | "report";
  /** How long `enforce` waits for runs in progress, in milliseconds. */
  waitMs: number;
  /** The pause between two looks, in milliseconds. */
  pollMs: number;
}

/** A failed run, or a failed earlier attempt of a run, of one workflow on the commit. */
export interface FailedAttempt {
  workflow: DispatchedWorkflow;
  runId: number;
  attempt: number;
  /** The run's attempt count when the gate looked, so "attempt 1 of 2" shows a re-run. */
  attempts: number;
  conclusion: string;
  htmlUrl: string;
  /** The jobs of that attempt that concluded neither `success` nor `skipped`, with conclusions. */
  failedJobs: string[];
}

/** The gate's verdict, the lines for the job summary, and every failure it found on the commit. */
export interface GateResult {
  ok: boolean;
  lines: string[];
  failures: FailedAttempt[];
}

/** The clock and the pause, which tests replace. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const get = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

function text(value: unknown, name: string, where: string): string {
  const field = get(value, name);
  if (typeof field !== "string") {
    throw new Error(`${where}: field ${name} is not a string`);
  }
  return field;
}

/**
 * Reads the response of "List workflow runs for a workflow".
 * @param response - The parsed JSON body.
 * @returns The runs, newest first.
 */
export function parseGateRuns(response: unknown): GateRun[] {
  const runs = get(response, "workflow_runs");
  if (!Array.isArray(runs)) {
    throw new Error("workflow runs: field workflow_runs is not a list");
  }
  return runs.map((run: unknown, index) => {
    const where = `workflow run ${index}`;
    const id = get(run, "id");
    if (typeof id !== "number" || !Number.isInteger(id)) {
      throw new Error(`${where}: field id is not an integer`);
    }
    const conclusion = get(run, "conclusion");
    if (conclusion !== null && typeof conclusion !== "string") {
      throw new Error(`${where}: field conclusion is not a string or null`);
    }
    const attempt = get(run, "run_attempt");
    if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) {
      throw new Error(`${where}: field run_attempt is not a positive integer`);
    }
    return {
      id,
      event: text(run, "event", where),
      headSha: text(run, "head_sha", where),
      status: text(run, "status", where),
      conclusion,
      htmlUrl: text(run, "html_url", where),
      attempt,
    };
  });
}

/**
 * The runs that may prove a commit passed: that exact commit, and not a pull-request run, which
 * tests a merge of the pull request into its base rather than the commit itself.
 * @param runs - The runs, newest first.
 * @param sha - The commit.
 * @returns The candidates, newest first.
 */
export function gateCandidates(runs: readonly GateRun[], sha: string): GateRun[] {
  return runs.filter((run) => run.headSha === sha && run.event !== "pull_request");
}

async function runsOf(
  github: GateGitHub,
  repo: string,
  workflow: string,
  sha: string,
): Promise<GateRun[]> {
  const query = new URLSearchParams({ head_sha: sha, per_page: "100" });
  return gateCandidates(
    parseGateRuns(
      await github.get(`repos/${repo}/actions/workflows/${workflow}/runs?${query.toString()}`),
    ),
    sha,
  );
}

/**
 * Whether every job of a run concluded `success`, and there is at least one. A job skipped by an
 * `if:` or a path condition does not count, so a run that tested nothing never passes.
 * @param jobs - The jobs of the run.
 */
export function everyJobPassed(jobs: readonly Job[]): boolean {
  return jobs.length > 0 && jobs.every((job) => job.conclusion === "success");
}

/**
 * Looks for a run of a workflow on a commit that completed with `success`.
 * @param since - A run id. A failed run at or below it is ignored, so a failure from before a
 * dispatch does not end the wait; a passed run counts whatever its id.
 * @param checkJobs - Also read the run's jobs and require {@link everyJobPassed}. GitHub reports a
 * run whose jobs were all skipped as `success`, so a workflow that gains a conditional job could
 * otherwise pass the gate untested. ci.yml skips some jobs on push by design and is read without it.
 * @returns The newest passing run, else a run in progress, else the newest failed run, else missing.
 */
export async function findConcluded(
  github: GateGitHub,
  repo: string,
  workflow: string,
  sha: string,
  since: number = 0,
  checkJobs: boolean = false,
): Promise<Found> {
  const runs = await runsOf(github, repo, workflow, sha);
  let failed: GateRun | undefined;
  for (const run of runs) {
    if (run.status !== "completed") {
      continue;
    }
    if (
      run.conclusion === "success" &&
      (!checkJobs ||
        everyJobPassed(
          parseJobs(await github.get(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`)),
        ))
    ) {
      return { state: "passed", run };
    }
    if (run.id > since) {
      failed = preferFailure(failed, run);
    }
  }
  const pending = runs.find((run) => run.status !== "completed");
  if (pending !== undefined) {
    return { state: "pending", run: pending };
  }
  return failed === undefined ? { state: "missing" } : { state: "failed", run: failed };
}

/**
 * Looks for a passing ci.yml run on a commit: one that completed with `success`. Its jobs are not
 * read: ci.yml skips some jobs on push and on dispatch by design.
 * @param since - See {@link findConcluded}.
 * @returns The newest passing run, else a run in progress, else the newest failed run, else missing.
 */
export async function findLinux(
  github: GateGitHub,
  repo: string,
  sha: string,
  since: number = 0,
): Promise<Found> {
  return await findConcluded(github, repo, LINUX_WORKFLOW, sha, since);
}

/**
 * Looks for a ci-all-os.yml run on a commit whose macOS and Windows test jobs both passed.
 * @param since - A run id. A failed run at or below it is ignored, so a failure from before the
 * dispatch does not end the wait; a passed run counts whatever its id.
 * @returns The newest passing run, else a run in progress, else the newest failed run, else missing.
 */
export async function findAllOs(
  github: GateGitHub,
  repo: string,
  sha: string,
  since: number = 0,
): Promise<Found> {
  const runs = await runsOf(github, repo, ALL_OS_WORKFLOW, sha);
  let failed: GateRun | undefined;
  for (const run of runs) {
    if (run.status !== "completed") {
      continue;
    }
    const jobs = parseJobs(
      await github.get(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`),
    );
    if (bothPassed(jobs)) {
      return { state: "passed", run };
    }
    if (run.id > since) {
      failed = preferFailure(failed, run);
    }
  }
  const pending = runs.find((run) => run.status !== "completed");
  if (pending !== undefined) {
    return { state: "pending", run: pending };
  }
  return failed === undefined ? { state: "missing" } : { state: "failed", run: failed };
}

/** Job conclusions that are not a failure: `success`, `skipped` (an `if:` or path condition) and `neutral`. */
const NOT_FAILED: ReadonlySet<string> = new Set(["success", "skipped", "neutral"]);

async function failedJobs(github: GateGitHub, jobsPath: string): Promise<string[]> {
  return parseJobs(await github.get(jobsPath))
    .filter((job) => job.conclusion === null || !NOT_FAILED.has(job.conclusion))
    .map((job) => `${job.name} (${job.conclusion ?? "no conclusion"})`);
}

/**
 * Lists every failure of a workflow on a commit, newest first: each completed run that concluded
 * anything but `success`, and each earlier attempt of a run that did, so a run whose failed jobs
 * were re-run until they passed still shows its failed attempt.
 * @param workflow - The workflow.
 * @returns The failures, with the jobs that failed in each.
 */
export async function findFailures(
  github: GateGitHub,
  repo: string,
  workflow: DispatchedWorkflow,
  sha: string,
): Promise<FailedAttempt[]> {
  const failures: FailedAttempt[] = [];
  for (const run of await runsOf(github, repo, workflow, sha)) {
    const base = { workflow, runId: run.id, attempts: run.attempt };
    if (run.status === "completed" && run.conclusion !== "success") {
      failures.push({
        ...base,
        attempt: run.attempt,
        conclusion: run.conclusion ?? "no conclusion",
        htmlUrl: run.htmlUrl,
        failedJobs: await failedJobs(
          github,
          `repos/${repo}/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=100`,
        ),
      });
    }
    for (let attempt = run.attempt - 1; attempt >= 1; attempt -= 1) {
      const attemptPath = `repos/${repo}/actions/runs/${run.id}/attempts/${attempt}`;
      const [earlier] = parseGateRuns({ workflow_runs: [await github.get(attemptPath)] });
      if (earlier === undefined || earlier.conclusion === "success") {
        continue;
      }
      failures.push({
        ...base,
        attempt,
        conclusion: earlier.conclusion ?? "no conclusion",
        htmlUrl: `${run.htmlUrl}/attempts/${attempt}`,
        failedJobs: await failedJobs(github, `${attemptPath}/jobs?per_page=100`),
      });
    }
  }
  return failures;
}

/**
 * The summary section that lists the failures, so a pass after a failure is never silent.
 * @param failures - What {@link findFailures} found for each workflow.
 */
export function describeFailures(failures: readonly FailedAttempt[]): string {
  if (failures.length === 0) {
    return "No run of the four workflows failed on this commit, pull-request runs aside.";
  }
  return [
    "Failed runs on this commit, pull-request runs aside. A later pass does not erase them: read each one, and decide whether it was a flake, before approving `npm-publish`.",
    ...failures.map(
      (failure) =>
        `- ${failure.workflow}: run [${failure.runId}](${failure.htmlUrl}), attempt ${failure.attempt} of ${failure.attempts}, concluded ${failure.conclusion}. ${
          failure.failedJobs.length === 0
            ? "No job failed; the run page shows the cause."
            : `Failed jobs: ${failure.failedJobs.join(", ")}.`
        }`,
    ),
  ].join("\n");
}

function describe(workflow: string, found: Found, dispatchedOn?: string): string {
  if (found.state === "missing" && dispatchedOn !== undefined) {
    return `${workflow}: dispatched on ${dispatchedOn}; its run is not listed yet.`;
  }
  switch (found.state) {
    case "passed":
      return `${workflow}: run [${found.run.id}](${found.run.htmlUrl}) passed on this commit.`;
    case "pending":
      return `${workflow}: run [${found.run.id}](${found.run.htmlUrl}) is still ${found.run.status}.`;
    case "failed":
      if (found.run.conclusion === "success") {
        return `${workflow}: the newest run on this commit, [${found.run.id}](${found.run.htmlUrl}), concluded success but skipped a job, so it was not fully tested.`;
      }
      return `${workflow}: the newest run on this commit, [${found.run.id}](${found.run.htmlUrl}), did not pass (${found.run.conclusion ?? "no conclusion"}).`;
    case "missing":
      return `${workflow}: no run on this commit, pull-request runs aside.`;
    default:
      return found satisfies never;
  }
}

/**
 * Looks for a passing run of one of the dispatched workflows on a commit.
 * @param since - See {@link findConcluded}.
 */
async function findDispatched(
  github: GateGitHub,
  repo: string,
  workflow: DispatchedWorkflow,
  sha: string,
  since: number,
): Promise<Found> {
  switch (workflow) {
    case LINUX_WORKFLOW:
      return await findLinux(github, repo, sha, since);
    case ALL_OS_WORKFLOW:
      return await findAllOs(github, repo, sha, since);
    case HARDHAT_VERSIONS_WORKFLOW:
    case SDK_FLOORS_WORKFLOW:
      return await findConcluded(github, repo, workflow, sha, since, true);
    default:
      return workflow satisfies never;
  }
}

/** The highest run id among the candidates, so a dispatch can tell its run from older ones. */
async function newestRunId(
  github: GateGitHub,
  repo: string,
  workflow: string,
  sha: string,
): Promise<number> {
  const runs = await runsOf(github, repo, workflow, sha);
  return runs.reduce((highest, run) => Math.max(highest, run.id), 0);
}

/**
 * Whether a completed run that did not pass was not fully tested rather than failed: it was
 * cancelled (as when a newer push to main replaces a pending run in its concurrency group), or it
 * concluded `success` with a skipped job.
 */
export function notFullyTested(run: GateRun): boolean {
  return run.conclusion === "success" || run.conclusion === "cancelled";
}

/** Of two runs that did not pass, newest first, the one the gate acts on: a failure before an untested run. */
function preferFailure(current: GateRun | undefined, older: GateRun): GateRun {
  return current === undefined || (notFullyTested(current) && !notFullyTested(older))
    ? older
    : current;
}

/**
 * Whether a found run ends the gate under {@link RETRY_RULES}:
 * - a run dispatched on the commit (event `workflow_dispatch`) that did not pass: it is the one
 *   dispatch, or the one retry, so a re-run of the gate job does not grant another;
 * - a failed run of a workflow the gate does not retry.
 * Any other run that did not pass was not fully tested, or may be retried, so the gate dispatches.
 */
export function stopsGate(workflow: DispatchedWorkflow, found: Found): boolean {
  if (found.state !== "failed") {
    return false;
  }
  return (
    found.run.event === "workflow_dispatch" ||
    (!notFullyTested(found.run) && !retriesFailure(workflow))
  );
}

/**
 * Runs the gate.
 * @param input - The commit, the tag and the mode.
 * @param github - The API client.
 * @param clock - The clock; tests pass a fake one.
 * @returns The verdict and the summary lines.
 */
export async function gate(
  input: GateInput,
  github: GateGitHub,
  clock: Clock,
): Promise<GateResult> {
  const { repo, sha, ref, mode } = input;
  const header = `CI gate for \`${sha}\` (${ref}):`;
  // Every verdict ends with the list of failures on the commit.
  const finish = async (ok: boolean, lines: string[]): Promise<GateResult> => {
    const failures = (
      await Promise.all(
        DISPATCHED_WORKFLOWS.map(
          async (workflow) => await findFailures(github, repo, workflow, sha),
        ),
      )
    ).flat();
    return { ok, lines: [...lines, describeFailures(failures)], failures };
  };
  const lookAll = async (dispatchedAfter: ReadonlyMap<string, number>) =>
    await Promise.all(
      DISPATCHED_WORKFLOWS.map(async (workflow) => ({
        workflow,
        found: await findDispatched(
          github,
          repo,
          workflow,
          sha,
          dispatchedAfter.get(workflow) ?? 0,
        ),
      })),
    );
  if (mode === "report") {
    const others = await lookAll(new Map());
    const lines = [
      `${header} dry run, nothing dispatched.`,
      ...others.map(({ workflow, found }) => describe(workflow, found)),
    ];
    for (const { workflow, found } of others) {
      if (stopsGate(workflow, found)) {
        lines.push(
          `A release run would fail: the newest ${workflow} run on this commit did not pass, and the gate does not retry it.`,
        );
      } else if (found.state === "missing" || found.state === "failed") {
        lines.push(`A release run would dispatch ${workflow} on ${ref} and wait for it.`);
      }
    }
    return await finish(true, lines);
  }

  const deadline = clock.now() + input.waitMs;
  // The highest run id of each workflow on the commit just before the gate dispatched it.
  const dispatchedAfter = new Map<string, number>();
  for (;;) {
    const others = await lookAll(dispatchedAfter);
    // A dispatched workflow whose only listed run is from before the dispatch has no run of its
    // own to show yet.
    const describeAll = () =>
      others.map(({ workflow, found }) => {
        const after = dispatchedAfter.get(workflow);
        if (after === undefined) {
          return describe(workflow, found);
        }
        return describe(
          workflow,
          found.state === "failed" && found.run.id <= after ? { state: "missing" } : found,
          ref,
        );
      });
    const status = describeAll();
    if (others.every(({ found }) => found.state === "passed")) {
      return await finish(true, [header, ...status]);
    }
    const failedDispatches = others.filter(
      ({ workflow, found }) => found.state === "failed" && dispatchedAfter.has(workflow),
    );
    if (failedDispatches.length > 0) {
      return await finish(false, [
        header,
        ...status,
        ...failedDispatches.map(
          ({ workflow }) =>
            `The ${workflow} run dispatched on ${ref} did not pass. Open it from the link above: re-run its failed jobs if the failure is a flake, then re-run this job; otherwise fix the cause on the branch the tag came from and release a new version.`,
        ),
      ]);
    }
    const notRetried = others.filter(
      ({ workflow, found }) => stopsGate(workflow, found) && !dispatchedAfter.has(workflow),
    );
    if (notRetried.length > 0) {
      return await finish(false, [
        header,
        ...status,
        ...notRetried.map(
          ({ workflow }) =>
            `The newest ${workflow} run on this commit did not pass, and the gate does not retry it. Open it from the link above: re-run its failed jobs if the failure is a flake, then re-run this job; otherwise fix the cause and release a new version.`,
        ),
      ]);
    }
    for (const { workflow, found } of others) {
      if (
        (found.state === "missing" || found.state === "failed") &&
        !dispatchedAfter.has(workflow)
      ) {
        dispatchedAfter.set(workflow, await newestRunId(github, repo, workflow, sha));
        await github.dispatch(workflow, ref);
        process.stdout.write(`dispatched ${workflow} on ${ref}\n`);
      }
    }
    const waited = describeAll();
    if (clock.now() >= deadline) {
      return await finish(false, [
        header,
        ...waited,
        `Gave up after ${Math.round(input.waitMs / 60_000)} minutes. Re-run this job once the runs above have finished; a dispatched run that is not listed yet is on its workflow's Actions page.`,
      ]);
    }
    process.stdout.write(`waiting: ${waited.join(" ")}\n`);
    await clock.sleep(input.pollMs);
  }
}

/** Runs a command and resolves with its standard output. */
export type Exec = (file: string, args: readonly string[]) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);
const defaultExec: Exec = async (file, args) =>
  await execFileAsync(file, [...args], { maxBuffer: 64 * 1024 * 1024 });

/**
 * A {@link GateGitHub} on `gh api`, which reads its token from GH_TOKEN.
 * @param repo - The repository, `owner/name`.
 * @param exec - Runs `gh`; tests pass a fake.
 * @returns The client.
 */
export function gateClient(repo: string, exec: Exec = defaultExec): GateGitHub {
  const call = async (args: readonly string[]): Promise<string> => {
    try {
      return (await exec("gh", ["api", ...args])).stdout;
    } catch (error: unknown) {
      const stderr = get(error, "stderr");
      const detail =
        typeof stderr === "string" && stderr.trim() !== ""
          ? stderr.trim()
          : error instanceof Error
            ? error.message
            : String(error);
      throw new Error(`gh api ${args.join(" ")} failed: ${detail}`, { cause: error });
    }
  };
  return {
    get: async (apiPath) => {
      const parsed: unknown = JSON.parse(await call([apiPath]));
      return parsed;
    },
    // The endpoint answers 204 with no body.
    dispatch: async (workflow, ref) => {
      await call([
        "--method",
        "POST",
        `repos/${repo}/actions/workflows/${workflow}/dispatches`,
        "-f",
        `ref=${ref}`,
      ]);
    },
  };
}

/** Escapes a workflow-command message, as the Actions toolkit does. */
export function annotation(message: string): string {
  return message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

/**
 * One warning annotation per failure, so each shows on the run page as well as in the summary.
 * @param failures - What the gate found.
 */
export function annotations(failures: readonly FailedAttempt[]): string[] {
  return failures.map(
    (failure) =>
      `::warning title=Failed CI run on the tagged commit::${annotation(
        `${failure.workflow} run ${failure.runId} attempt ${failure.attempt} of ${failure.attempts} concluded ${failure.conclusion}. ${failure.htmlUrl}`,
      )}`,
  );
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`--${name} is required`);
  }
  return value;
}

async function main(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: "string" },
      sha: { type: "string" },
      ref: { type: "string" },
      mode: { type: "string", default: "enforce" },
      "wait-minutes": { type: "string", default: "90" },
      summary: { type: "string" },
    },
  });
  const repo = required(values.repo, "repo");
  const mode = values.mode;
  if (mode !== "enforce" && mode !== "report") {
    throw new Error(`--mode must be enforce or report, not ${mode}`);
  }
  const minutes = Number(values["wait-minutes"]);
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new Error(
      `--wait-minutes must be a whole number of minutes, 0 or more, not ${values["wait-minutes"]}`,
    );
  }
  const result = await gate(
    {
      repo,
      sha: required(values.sha, "sha"),
      ref: required(values.ref, "ref"),
      mode,
      waitMs: minutes * 60_000,
      pollMs: 30_000,
    },
    gateClient(repo),
    {
      now: () => Date.now(),
      sleep: async (ms) => {
        await new Promise((resolve) => {
          setTimeout(resolve, ms);
        });
      },
    },
  );
  const report = `${result.lines.join("\n\n")}\n`;
  for (const line of annotations(result.failures)) {
    process.stdout.write(`${line}\n`);
  }
  if (values.summary !== undefined) {
    appendFileSync(values.summary, report);
  }
  process.stdout.write(report);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
