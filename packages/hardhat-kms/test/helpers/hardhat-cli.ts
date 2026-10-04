// Runs the real Hardhat CLI in a child process, as a user runs it, for the integration tests that
// cover what the programmatic API cannot: exit codes, open handles, top-level await, and output on
// the terminal.
//
// The run is asynchronous, so a node or a server in the test process can answer the child. Starting
// Hardhat with the plugin takes 3 s on an idle machine and over 40 s on a loaded one, so the time a
// run may take is split in two:
// - A run whose script prints a READY line gets a startup limit until that line and a work limit
//   after it. The work limit can then be tight, since it does not include the startup.
// - A run with no marker, such as a `kms` task or a script copied from the docs, cannot tell its
//   startup from its work, so it gets one limit, RUN_LIMIT_MS, sized for a loaded startup.
// The helper stops the child with SIGKILL at a limit, at a stderr line the test names, or when the
// test's signal aborts, and the result says which and when. On Node 22, `node --test --test-timeout`
// limits each test file, not each test, and ends a file that runs past it with SIGTERM, which skips
// every `finally` and abort listener; a SIGTERM handler here ends the children then. The helper
// does not end the child's own children: a grandchild that keeps stdout open delays the result
// until it exits.
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Hardhat's CLI entry point, run with Node and no package manager in between. */
export const HARDHAT_CLI: string = path.join(repo, "node_modules/hardhat/dist/src/cli.js");

/**
 * How long a run without a READY marker may take: a loaded startup of over 40 s, the task and a
 * margin, and below the 120 s per-test limit that `pnpm run test:integration` sets on Node 24 and
 * later. On Node 22 the script sets no per-test limit, so this one is the only limit of such a run.
 */
export const RUN_LIMIT_MS: number = 100_000;

/** The children still running, ended when the test process gets SIGTERM. */
const running = new Set<ChildProcess>();

process.once("SIGTERM", () => {
  for (const child of running) {
    child.kill("SIGKILL");
  }
  process.exit(143);
});

/**
 * Ends `child` with the test process, also when Node's test runner ends the file with SIGTERM.
 *
 * @param child - A child the test started, such as `hardhat node`.
 */
export function endWithTestProcess(child: ChildProcess): void {
  running.add(child);
  child.once("exit", () => running.delete(child));
}

/** How long a run may take. */
export type RunLimits =
  | {
      /** The limit from the start to the exit. */
      limitMs: number;
    }
  | {
      /** The stdout line that ends the startup, such as `/^READY$/m`. */
      ready: RegExp;
      /** The limit from the start to the READY line. */
      startupLimitMs: number;
      /** The limit from the READY line to the exit. */
      workLimitMs: number;
    };

export interface HardhatRunOptions {
  /** The project directory. */
  cwd: string;
  /** Extra environment variables, applied after the defaults of {@link hardhatEnv}. */
  env?: Record<string, string>;
  /** The limits. Without them, the run gets {@link RUN_LIMIT_MS} from start to exit. */
  limits?: RunLimits;
  /** A stderr pattern that stops the run at its first match, such as the plugin's warning. */
  stopOn?: { pattern: RegExp; reason: string };
  /**
   * A signal that stops the run when it aborts. Pass the test context's `signal`, which aborts when
   * the test ends or times out.
   */
  signal?: AbortSignal | undefined;
}

/** How a run ended. */
export interface HardhatRun {
  /** The exit code, or `null` when the run was stopped or ended by a signal. */
  status: number | null;
  /** Why the helper stopped the run, and when, if it did. */
  stopped?: string;
  stdout: string;
  stderr: string;
  /** stdout followed by stderr, for checks that do not care which stream a line is on. */
  output: string;
  /** How the run ended, then its stdout and stderr, for failure messages. */
  report: string;
}

/**
 * `NODE_OPTIONS` without `--import tsx`.
 *
 * @param options - The test process's `NODE_OPTIONS`.
 * @returns The other options, or `""`.
 */
function withoutTsx(options: string | undefined): string {
  return (options ?? "")
    .replaceAll(/(?:^|\s)--import(?:=|\s+)tsx(?=\s|$)/g, " ")
    .trim()
    .replaceAll(/\s+/g, " ");
}

/**
 * The environment of a Hardhat child: the test process's environment, without what would make the
 * run differ from a user's, then `extra`.
 *
 * @param extra - Variables to add or override.
 * @returns The environment.
 */
export function hardhatEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // A black-box run: Hardhat loads the plugin through its own TypeScript loader, and that coverage
    // data would clash with the native runs of the same files.
    NODE_V8_COVERAGE: "",
    // CI adds --import tsx on Node 22.13 for the test runner. A user's shell does not, and the CLI
    // does not need it: Hardhat registers tsx itself. Any other option stays, such as the
    // deprecation preload of the Node 26 CI leg (scripts/fail-on-deprecation.mjs).
    NODE_OPTIONS: withoutTsx(process.env["NODE_OPTIONS"]),
    HARDHAT_KMS: "",
    AWS_KMS_KEY_ID: "",
    AWS_KMS_KEY_IDS: "",
    ...extra,
  };
}

/**
 * Runs `hardhat <args>` in a project and waits for it to exit or be stopped.
 *
 * @param args - The CLI arguments.
 * @param options - The project, environment, limits and stop conditions.
 * @returns How the run ended, with its output.
 */
export async function runHardhat(args: string[], options: HardhatRunOptions): Promise<HardhatRun> {
  const limits = options.limits ?? { limitMs: RUN_LIMIT_MS };
  const child = spawn(process.execPath, [HARDHAT_CLI, ...args], {
    cwd: options.cwd,
    env: hardhatEnv(options.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  endWithTestProcess(child);
  const started = Date.now();
  let stopped: string | undefined;
  let stdout = "";
  let stderr = "";
  const stop = (reason: string): void => {
    if (stopped === undefined && child.exitCode === null && child.signalCode === null) {
      stopped = `${reason}, ${Date.now() - started} ms after the start`;
      child.kill("SIGKILL");
    }
  };
  let timer =
    "ready" in limits
      ? setTimeout(() => {
          stop(`no READY within ${limits.startupLimitMs} ms`);
        }, limits.startupLimitMs)
      : setTimeout(() => {
          stop(`no exit within ${limits.limitMs} ms`);
        }, limits.limitMs);
  let ready = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if ("ready" in limits && !ready && limits.ready.test(stdout)) {
      ready = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        stop(`no exit within ${limits.workLimitMs} ms of READY`);
      }, limits.workLimitMs);
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    if (options.stopOn?.pattern.test(stderr) === true) {
      stop(options.stopOn.reason);
    }
  });
  const onAbort = (): void => {
    stop("the test was cancelled or timed out");
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted === true) {
    onAbort();
  }
  let status: number | null = null;
  try {
    const [code] = await once(child, "close");
    status = typeof code === "number" ? code : null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    // Ends the child when `once` rejected, on a spawn error.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  const ended =
    stopped !== undefined
      ? `stopped by the test: ${stopped}`
      : status === null
        ? `ended by ${String(child.signalCode)}`
        : `exited with ${String(status)}${status === 13 ? " (a top-level await never settled)" : ""}`;
  return {
    status,
    ...(stopped === undefined ? {} : { stopped }),
    stdout,
    stderr,
    output: `${stdout}${stderr}`,
    report: `hardhat ${args.join(" ")} ${ended}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  };
}
