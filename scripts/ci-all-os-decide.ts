// The two decisions of ci-all-os.yml, the macOS and Windows test workflow:
// - decide: whether a run tests. A scheduled run skips when a run of this workflow on `main` already
//   passed both the macOS and the Windows test job on the same commit. A run whose test jobs were
//   skipped (a nightly skip, a dry run) never counts, although its conclusion is `success`. A manual
//   dispatch always tests, unless it is a dry run, which only reports what a nightly run would do.
// - report: keeps one tracking issue for failures on `main`. A failure opens it, or comments on it if
//   it is open; a pass comments on the open issue and closes it.
// It talks to the GitHub API through `gh api`, which reads its token from GH_TOKEN, so CI needs Node
// and no `pnpm install`. If an API call fails, the script fails: it never skips on an error.
//
// Usage:
//   node scripts/ci-all-os-decide.ts decide --repo OWNER/NAME --sha SHA --event schedule|workflow_dispatch
//     [--run-id ID] [--dry-run true|false] [--output FILE] [--summary FILE]
//   node scripts/ci-all-os-decide.ts report --repo OWNER/NAME --sha SHA --run-url URL
//     --result success|failure|decide-failure
// `--output` appends `run=true|false` (GITHUB_OUTPUT) and `--summary` appends the decision line
// (GITHUB_STEP_SUMMARY). Both commands print what they decided.
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

/** The branch whose commits the nightly run tests. */
export const BRANCH = "main";
/** The title of the tracking issue; the report finds the open issue by this exact title. */
export const ISSUE_TITLE = "Nightly macOS and Windows CI fails on main";
/** The labels of a new tracking issue. */
export const ISSUE_LABELS: readonly string[] = [
  "type:bug",
  "area:ci",
  "status:needs-triage",
  "priority:P1",
];
/** Name prefixes of the two test jobs. Both must conclude `success` for a run to count as a pass. */
export const TEST_JOBS: readonly string[] = ["Test (macOS,", "Test (Windows,"];

/** The fields of a workflow run this script reads. */
export interface WorkflowRun {
  id: number;
  event: string;
  headBranch: string;
  headSha: string;
  htmlUrl: string;
}

/** The fields of a job this script reads. */
export interface Job {
  name: string;
  conclusion: string | null;
}

/** The fields of an issue this script reads. */
export interface Issue {
  number: number;
  title: string;
}

/** The GitHub API calls this script makes. Tests pass a fake. */
export interface GitHub {
  /** GET one page. */
  get(apiPath: string): Promise<unknown>;
  /** GET every page of a list. */
  list(apiPath: string): Promise<unknown[]>;
  /** POST or PATCH with string fields; an array value is sent as a JSON array. */
  send(method: "POST" | "PATCH", apiPath: string, fields: Fields): Promise<unknown>;
}

/** Request fields for {@link GitHub.send}. */
export type Fields = Record<string, string | readonly string[]>;

/** What `decide` concluded: whether the test jobs run, and the line for the job summary. */
export interface Decision {
  run: boolean;
  summary: string;
}

/** The input of {@link decide}. */
export interface DecideInput {
  repo: string;
  sha: string;
  event: string;
  dryRun: boolean;
  /** The current run, which is never its own match. */
  runId?: number;
}

/**
 * The result of a run that reports: the test jobs passed, the test jobs failed, or the decide job
 * failed, so no test ran.
 */
export type RunResult = "success" | "failure" | "decide-failure";

/** What `report` does with the tracking issue. */
export type ReportAction =
  | { kind: "open"; title: string; body: string; labels: readonly string[] }
  | { kind: "comment"; issue: number; body: string }
  | { kind: "close"; issue: number; body: string }
  | { kind: "none" };

const get = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

function text(value: unknown, name: string, where: string): string {
  const field = get(value, name);
  if (typeof field !== "string") {
    throw new Error(`${where}: field ${name} is not a string`);
  }
  return field;
}

function integer(value: unknown, name: string, where: string): number {
  const field = get(value, name);
  if (typeof field !== "number" || !Number.isInteger(field)) {
    throw new Error(`${where}: field ${name} is not an integer`);
  }
  return field;
}

function array(value: unknown, name: string, where: string): unknown[] {
  const field = get(value, name);
  if (!Array.isArray(field)) {
    throw new Error(`${where}: field ${name} is not a list`);
  }
  return field;
}

/**
 * Reads the response of "List workflow runs for a workflow".
 * @param response The parsed JSON body.
 * @returns The runs, in the order of the response (newest first).
 */
export function parseRuns(response: unknown): WorkflowRun[] {
  return array(response, "workflow_runs", "workflow runs").map((run: unknown, index) => {
    const where = `workflow run ${index}`;
    return {
      id: integer(run, "id", where),
      event: text(run, "event", where),
      headBranch: text(run, "head_branch", where),
      headSha: text(run, "head_sha", where),
      htmlUrl: text(run, "html_url", where),
    };
  });
}

/**
 * Reads the response of "List jobs for a workflow run".
 * @param response The parsed JSON body.
 * @returns The jobs of the run's latest attempt.
 */
export function parseJobs(response: unknown): Job[] {
  return array(response, "jobs", "jobs").map((job: unknown, index) => {
    const where = `job ${index}`;
    const conclusion = get(job, "conclusion");
    if (conclusion !== null && typeof conclusion !== "string") {
      throw new Error(`${where}: field conclusion is not a string or null`);
    }
    return { name: text(job, "name", where), conclusion };
  });
}

/**
 * Reads the pages of "List repository issues". The list also holds pull requests; they are dropped.
 * @param pages One parsed JSON body per page.
 * @returns The issues.
 */
export function parseIssues(pages: unknown[]): Issue[] {
  return pages.flatMap((page: unknown, pageIndex) => {
    if (!Array.isArray(page)) {
      throw new Error(`issues page ${pageIndex}: not a list`);
    }
    return page.flatMap((issue: unknown, index): Issue[] => {
      const where = `issues page ${pageIndex}, item ${index}`;
      const pullRequest = get(issue, "pull_request");
      if (pullRequest !== undefined && pullRequest !== null) {
        return [];
      }
      return [{ number: integer(issue, "number", where), title: text(issue, "title", where) }];
    });
  });
}

/**
 * Picks the runs that may prove a commit passed: runs on `main` (not pull requests) of that exact
 * commit, other than the current run.
 * @param runs The runs, newest first.
 * @param sha The commit.
 * @param currentRunId The current run, if any.
 * @returns The candidate runs, newest first.
 */
export function candidateRuns(
  runs: readonly WorkflowRun[],
  sha: string,
  currentRunId?: number,
): WorkflowRun[] {
  return runs.filter(
    (run) =>
      run.headSha === sha &&
      run.headBranch === BRANCH &&
      run.event !== "pull_request" &&
      run.id !== currentRunId,
  );
}

/**
 * Whether a run passed on both OSes: it has at least one macOS and one Windows test job, and every
 * one of them concluded `success`. A skipped job has the conclusion `skipped`, so a skipped run
 * never passes.
 * @param jobs The jobs of the run's latest attempt.
 * @returns True when every macOS and Windows test job passed.
 */
export function bothPassed(jobs: readonly Job[]): boolean {
  return TEST_JOBS.every((prefix) => {
    const matching = jobs.filter((job) => job.name.startsWith(prefix));
    return matching.length > 0 && matching.every((job) => job.conclusion === "success");
  });
}

/**
 * Finds the newest run on `main` that passed both test jobs on a commit.
 * @param github The API client.
 * @param repo The repository, `owner/name`.
 * @param sha The commit.
 * @param currentRunId The current run, which is skipped.
 * @returns The run, or undefined when none passed.
 */
export async function findPassingRun(
  github: GitHub,
  repo: string,
  sha: string,
  currentRunId?: number,
): Promise<WorkflowRun | undefined> {
  const query = new URLSearchParams({ branch: BRANCH, head_sha: sha, per_page: "100" });
  const runs = parseRuns(
    await github.get(`repos/${repo}/actions/workflows/ci-all-os.yml/runs?${query.toString()}`),
  );
  for (const run of candidateRuns(runs, sha, currentRunId)) {
    const jobs = parseJobs(
      await github.get(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`),
    );
    if (bothPassed(jobs)) {
      return run;
    }
  }
  return undefined;
}

/**
 * Decides whether this run tests on macOS and Windows.
 * @param input The event and commit.
 * @param github The API client.
 * @returns The decision and the line for the job summary.
 */
export async function decide(input: DecideInput, github: GitHub): Promise<Decision> {
  const commit = `\`${input.sha}\``;
  if (input.event === "workflow_dispatch" && !input.dryRun) {
    return { run: true, summary: `Manual dispatch on ${commit}: the macOS and Windows tests run.` };
  }
  if (input.event !== "schedule" && input.event !== "workflow_dispatch") {
    throw new Error(`decide handles schedule and workflow_dispatch, not ${input.event}`);
  }
  const passed = await findPassingRun(github, input.repo, input.sha, input.runId);
  const reason =
    passed === undefined
      ? `no run of this workflow on \`${BRANCH}\` passed both on this commit.`
      : `run [${passed.id}](${passed.htmlUrl}) already passed both on this commit.`;
  if (input.dryRun) {
    const nightly = passed === undefined ? "run" : "skip";
    return {
      run: false,
      summary: `Dry run on ${commit}: no tests run. A nightly run would ${nightly} the macOS and Windows tests: ${reason}`,
    };
  }
  return passed === undefined
    ? { run: true, summary: `${commit}: the macOS and Windows tests run: ${reason}` }
    : { run: false, summary: `${commit}: the macOS and Windows tests are skipped: ${reason}` };
}

/**
 * Chooses what to do with the tracking issue after a run on `main`.
 * @param openIssues The open issues of the repository.
 * @param result The run's result.
 * @param sha The commit the run tested.
 * @param runUrl The run's page.
 * @returns Open, comment, close or nothing.
 */
export function planReport(
  openIssues: readonly Issue[],
  result: RunResult,
  sha: string,
  runUrl: string,
): ReportAction {
  const tracking = openIssues
    .filter((issue) => issue.title === ISSUE_TITLE)
    .toSorted((a, b) => a.number - b.number)[0];
  if (result === "success") {
    return tracking === undefined
      ? { kind: "none" }
      : {
          kind: "close",
          issue: tracking.number,
          body: `Passed on ${sha}: ${runUrl}. Closing.`,
        };
  }
  const decideFailed = result === "decide-failure";
  if (tracking !== undefined) {
    return {
      kind: "comment",
      issue: tracking.number,
      body: decideFailed
        ? `The decide job failed on ${sha}, so no tests ran: ${runUrl}`
        : `Failed again on ${sha}: ${runUrl}`,
    };
  }
  return {
    kind: "open",
    title: ISSUE_TITLE,
    labels: ISSUE_LABELS,
    body: [
      decideFailed
        ? `The decide job of the nightly macOS and Windows run (\`ci-all-os.yml\`) failed on \`${BRANCH}\`, so no tests ran.`
        : `The nightly macOS and Windows tests (\`ci-all-os.yml\`) failed on \`${BRANCH}\`.`,
      "",
      `- Commit: ${sha}`,
      `- Run: ${runUrl}`,
      "",
      "Each night runs the tests again until they pass on the newest commit. Further failures add a",
      "comment here; the next pass comments and closes this issue.",
    ].join("\n"),
  };
}

/**
 * Carries out a {@link ReportAction}.
 * @param github The API client.
 * @param repo The repository, `owner/name`.
 * @param action What to do.
 * @returns A line that says what was done.
 */
export async function applyReport(
  github: GitHub,
  repo: string,
  action: ReportAction,
): Promise<string> {
  if (action.kind === "none") {
    return "No open tracking issue; nothing to do.";
  }
  if (action.kind === "open") {
    const created = await github.send("POST", `repos/${repo}/issues`, {
      title: action.title,
      body: action.body,
      labels: action.labels,
    });
    return `Opened issue #${integer(created, "number", "new issue")}.`;
  }
  await github.send("POST", `repos/${repo}/issues/${action.issue}/comments`, {
    body: action.body,
  });
  if (action.kind === "comment") {
    return `Commented on issue #${action.issue}.`;
  }
  await github.send("PATCH", `repos/${repo}/issues/${action.issue}`, {
    state: "closed",
    state_reason: "completed",
  });
  return `Commented on and closed issue #${action.issue}.`;
}

/**
 * Reads the open issues and carries out the report for one run.
 * @param github The API client.
 * @param repo The repository, `owner/name`.
 * @param result The run's result.
 * @param sha The commit the run tested.
 * @param runUrl The run's page.
 * @returns A line that says what was done.
 */
export async function report(
  github: GitHub,
  repo: string,
  result: RunResult,
  sha: string,
  runUrl: string,
): Promise<string> {
  const issues = parseIssues(await github.list(`repos/${repo}/issues?state=open&per_page=100`));
  return await applyReport(github, repo, planReport(issues, result, sha, runUrl));
}

/** Runs a command and resolves with its standard output. */
export type Exec = (file: string, args: readonly string[]) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);
const defaultExec: Exec = async (file, args) =>
  await execFileAsync(file, [...args], { maxBuffer: 64 * 1024 * 1024 });

/**
 * A {@link GitHub} client on `gh api`, which reads its token from GH_TOKEN.
 * @param exec Runs `gh`; tests pass a fake.
 * @returns The client.
 */
export function ghClient(exec: Exec = defaultExec): GitHub {
  const call = async (args: readonly string[]): Promise<unknown> => {
    let stdout: string;
    try {
      ({ stdout } = await exec("gh", ["api", ...args]));
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
    const parsed: unknown = JSON.parse(stdout);
    return parsed;
  };
  return {
    get: async (apiPath) => await call([apiPath]),
    list: async (apiPath) => {
      const pages = await call(["--paginate", "--slurp", apiPath]);
      if (!Array.isArray(pages)) {
        throw new Error(`gh api --paginate --slurp ${apiPath}: not a list of pages`);
      }
      const list: unknown[] = pages;
      return list;
    },
    send: async (method, apiPath, fields) =>
      await call([
        "--method",
        method,
        apiPath,
        ...Object.entries(fields).flatMap(([name, value]) =>
          typeof value === "string"
            ? ["-f", `${name}=${value}`]
            : value.flatMap((item) => ["-f", `${name}[]=${item}`]),
        ),
      ]),
  };
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function boolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "" || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  throw new Error(`--${name} must be true or false, not ${value}`);
}

async function main(argv: readonly string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      sha: { type: "string" },
      event: { type: "string" },
      "run-id": { type: "string" },
      "dry-run": { type: "string" },
      output: { type: "string" },
      summary: { type: "string" },
      "run-url": { type: "string" },
      result: { type: "string" },
    },
  });
  const repo = required(values.repo, "repo");
  const sha = required(values.sha, "sha");
  const github = ghClient();
  const command = positionals[0];
  if (command === "decide") {
    const runIdText = values["run-id"];
    const runId = runIdText === undefined || runIdText === "" ? undefined : Number(runIdText);
    if (runId !== undefined && !Number.isInteger(runId)) {
      throw new Error(`--run-id must be an integer, not ${runIdText}`);
    }
    const decision = await decide(
      {
        repo,
        sha,
        event: required(values.event, "event"),
        dryRun: boolean(values["dry-run"], "dry-run"),
        ...(runId === undefined ? {} : { runId }),
      },
      github,
    );
    if (values.output !== undefined) {
      appendFileSync(values.output, `run=${String(decision.run)}\n`);
    }
    if (values.summary !== undefined) {
      appendFileSync(values.summary, `${decision.summary}\n`);
    }
    process.stdout.write(`run=${String(decision.run)}\n${decision.summary}\n`);
    return;
  }
  if (command === "report") {
    const result = required(values.result, "result");
    if (result !== "success" && result !== "failure" && result !== "decide-failure") {
      throw new Error(`--result must be success, failure or decide-failure, not ${result}`);
    }
    const done = await report(github, repo, result, sha, required(values["run-url"], "run-url"));
    process.stdout.write(`${done}\n`);
    return;
  }
  throw new Error(`unknown command ${command ?? "(none)"}; use decide or report`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
