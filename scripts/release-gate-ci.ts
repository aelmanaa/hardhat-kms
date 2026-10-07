// The CI gate of release.yml. Before anything is packed for npm, the tagged commit must have:
// - a run of ci.yml (the Linux jobs) that concluded `success`, and
// - a run of ci-all-os.yml whose macOS and Windows test jobs both passed (`bothPassed` of
//   scripts/ci-all-os-decide.ts, so a run whose test jobs were skipped never counts).
// Only runs of that exact commit count, and never pull-request runs: those test a merge commit.
// ci.yml runs on every push to main, so the merge commit of the Version Packages pull request has
// one; the gate waits while it is still in progress. ci-all-os.yml runs nightly and may have skipped
// the commit; then the gate dispatches it on the tag (`--ref`) and waits for the result.
// It talks to the GitHub API through `gh api`, which reads its token from GH_TOKEN.
//
// Usage:
//   node scripts/release-gate-ci.ts --repo OWNER/NAME --sha SHA --ref REF
//     [--mode enforce|report] [--wait-minutes N] [--summary FILE]
// `enforce` (the default) dispatches and waits, and exits 1 unless both runs passed. `report` is
// the dry run: it looks once, dispatches nothing, writes what it found and exits 0 unless the API
// fails. `--summary` appends the result lines (GITHUB_STEP_SUMMARY).
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

import { bothPassed, parseJobs } from "./ci-all-os-decide.ts";

/** The Linux workflow, which runs on every push to main. */
export const LINUX_WORKFLOW = "ci.yml";
/** The macOS and Windows workflow, which the gate dispatches when no run passed. */
export const ALL_OS_WORKFLOW = "ci-all-os.yml";

/** The fields of a workflow run the gate reads. */
export interface GateRun {
  id: number;
  event: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
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

/** The gate's verdict and the lines for the job summary. */
export interface GateResult {
  ok: boolean;
  lines: string[];
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
 * @param response The parsed JSON body.
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
    return {
      id,
      event: text(run, "event", where),
      headSha: text(run, "head_sha", where),
      status: text(run, "status", where),
      conclusion,
      htmlUrl: text(run, "html_url", where),
    };
  });
}

/**
 * The runs that may prove a commit passed: that exact commit, and not a pull-request run, which
 * tests a merge of the pull request into its base rather than the commit itself.
 * @param runs The runs, newest first.
 * @param sha The commit.
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
 * Looks for a passing ci.yml run on a commit: one that completed with `success`.
 * @returns The newest passing run, else a run in progress, else the newest failed run, else missing.
 */
export async function findLinux(github: GateGitHub, repo: string, sha: string): Promise<Found> {
  const runs = await runsOf(github, repo, LINUX_WORKFLOW, sha);
  const passed = runs.find((run) => run.status === "completed" && run.conclusion === "success");
  if (passed !== undefined) {
    return { state: "passed", run: passed };
  }
  const pending = runs.find((run) => run.status !== "completed");
  if (pending !== undefined) {
    return { state: "pending", run: pending };
  }
  const failed = runs[0];
  return failed === undefined ? { state: "missing" } : { state: "failed", run: failed };
}

/**
 * Looks for a ci-all-os.yml run on a commit whose macOS and Windows test jobs both passed.
 * @param since Only runs with an id above this count, so that a failure before a dispatch does
 * not end the wait for the dispatched run.
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
      failed ??= run;
    }
  }
  const pending = runs.find((run) => run.status !== "completed");
  if (pending !== undefined) {
    return { state: "pending", run: pending };
  }
  return failed === undefined ? { state: "missing" } : { state: "failed", run: failed };
}

function describe(workflow: string, found: Found): string {
  switch (found.state) {
    case "passed":
      return `${workflow}: run [${found.run.id}](${found.run.htmlUrl}) passed on this commit.`;
    case "pending":
      return `${workflow}: run [${found.run.id}](${found.run.htmlUrl}) is still ${found.run.status}.`;
    case "failed":
      return `${workflow}: the newest run on this commit, [${found.run.id}](${found.run.htmlUrl}), did not pass (${found.run.conclusion ?? "no conclusion"}).`;
    case "missing":
      return `${workflow}: no push or dispatch run on this commit.`;
    default:
      return found satisfies never;
  }
}

/** The highest run id among the candidates, so a dispatch can tell its run from older ones. */
async function newestRunId(github: GateGitHub, repo: string, sha: string): Promise<number> {
  const runs = await runsOf(github, repo, ALL_OS_WORKFLOW, sha);
  return runs.reduce((highest, run) => Math.max(highest, run.id), 0);
}

/**
 * Runs the gate.
 * @param input The commit, the tag and the mode.
 * @param github The API client.
 * @param clock The clock; tests pass a fake one.
 * @returns The verdict and the summary lines.
 */
export async function gate(
  input: GateInput,
  github: GateGitHub,
  clock: Clock,
): Promise<GateResult> {
  const { repo, sha, ref, mode } = input;
  const header = `CI gate for \`${sha}\` (${ref}):`;
  if (mode === "report") {
    const linux = await findLinux(github, repo, sha);
    const allOs = await findAllOs(github, repo, sha);
    const lines = [
      `${header} dry run, nothing dispatched.`,
      describe(LINUX_WORKFLOW, linux),
      describe(ALL_OS_WORKFLOW, allOs),
    ];
    if (allOs.state === "missing" || allOs.state === "failed") {
      lines.push(`A release run would dispatch ${ALL_OS_WORKFLOW} on ${ref} and wait for it.`);
    }
    return { ok: true, lines };
  }

  const deadline = clock.now() + input.waitMs;
  let dispatchedAfter: number | undefined;
  for (;;) {
    const linux = await findLinux(github, repo, sha);
    if (linux.state === "missing" || linux.state === "failed") {
      return {
        ok: false,
        lines: [
          header,
          describe(LINUX_WORKFLOW, linux),
          `Without a passing ${LINUX_WORKFLOW} run on the tagged commit nothing is published. Re-run the failed run, or tag a commit of main that passed.`,
        ],
      };
    }
    const allOs = await findAllOs(github, repo, sha, dispatchedAfter ?? 0);
    if (linux.state === "passed" && allOs.state === "passed") {
      return {
        ok: true,
        lines: [header, describe(LINUX_WORKFLOW, linux), describe(ALL_OS_WORKFLOW, allOs)],
      };
    }
    if (allOs.state === "failed" && dispatchedAfter !== undefined) {
      return {
        ok: false,
        lines: [header, describe(LINUX_WORKFLOW, linux), describe(ALL_OS_WORKFLOW, allOs)],
      };
    }
    if ((allOs.state === "missing" || allOs.state === "failed") && dispatchedAfter === undefined) {
      dispatchedAfter = await newestRunId(github, repo, sha);
      await github.dispatch(ALL_OS_WORKFLOW, ref);
      process.stdout.write(`dispatched ${ALL_OS_WORKFLOW} on ${ref}\n`);
    }
    if (clock.now() >= deadline) {
      return {
        ok: false,
        lines: [
          header,
          describe(LINUX_WORKFLOW, linux),
          describe(ALL_OS_WORKFLOW, allOs),
          `Gave up after ${Math.round(input.waitMs / 60_000)} minutes. Re-run this job once the runs above have finished.`,
        ],
      };
    }
    process.stdout.write(
      `waiting: ${describe(LINUX_WORKFLOW, linux)} ${describe(ALL_OS_WORKFLOW, allOs)}\n`,
    );
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
 * @param repo The repository, `owner/name`.
 * @param exec Runs `gh`; tests pass a fake.
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
    throw new Error(`--wait-minutes must be a whole number, not ${values["wait-minutes"]}`);
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
