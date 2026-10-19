// Runs the test suite at the versions the next Version Packages pull request will set (#552). On
// main the manifests carry the last released version until that pull request merges, so a test
// that hard-codes the current version passes every run on main and fails only on the pull request
// itself, as the 1.2.0 one did (#519). This script applies the pending changesets in a scratch
// worktree of HEAD and runs `pnpm test` there; the checkout it runs from is left as it is. It runs
// `pnpm test` only: lint, the docs checks, the examples and the consumer typecheck are not run at
// the bumped versions.
//
// The steps follow `pnpm run version-packages`, which release-pr.yml runs: `changeset version`,
// then the lockfile. For `changeset version` only, the scratch copy turns the changelog off, so it
// reads no git history and needs no GitHub token; @changesets/changelog-github would ask the
// GitHub API for the pull request of every changeset. The config is restored byte for byte before
// the tests run, since the tests read it. The tests do not read the changelogs.
//
// Usage: node scripts/test-bumped-versions.ts
//   Tests the committed HEAD, not uncommitted changes. Exits 0 without testing when HEAD has no
//   changeset or its changesets bump no version (empty changesets only), and with the exit code of
//   `pnpm test` otherwise. Ctrl-C or SIGTERM removes the scratch worktree and exits 130 or 143.
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isChangeset } from "./check-changeset-scope.ts";
import { readReleasePackages } from "./release-packages.ts";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

/** The exit code of a process ended by a signal: 128 plus the signal number. */
export const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

/**
 * Picks the changesets out of the output of `git ls-tree -z --name-only`.
 * @param output - NUL-separated paths from the repository root, unquoted.
 * @returns The changesets, sorted.
 */
export function pendingChangesets(output: string): string[] {
  return output
    .split("\0")
    .filter((file) => isChangeset(file))
    .toSorted();
}

/**
 * Turns the changelog off in a `.changeset/config.json`, so that `changeset version` needs no
 * network and no token.
 * @param text - The config file.
 * @returns The config with `"changelog": false`, everything else unchanged.
 * @throws When the file is not a JSON object.
 */
export function offlineConfig(text: string): string {
  const config: unknown = JSON.parse(text);
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(".changeset/config.json is not a JSON object");
  }
  return `${JSON.stringify({ ...config, changelog: false }, undefined, 2)}\n`;
}

/**
 * Lists the versions that changed.
 * @param before - Each published package and its version before `changeset version`.
 * @param after - The same after it.
 * @returns One `name before -> after` line per package whose version changed.
 */
export function versionChanges(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  const changes: string[] = [];
  for (const [name, version] of before) {
    const next = after.get(name);
    if (next !== undefined && next !== version) {
      changes.push(`${name} ${version} -> ${next}`);
    }
  }
  return changes;
}

/** The version of every published package in a tree. */
function versionsIn(root: string): Map<string, string> {
  const versions = new Map<string, string>();
  for (const { name, directory } of readReleasePackages(root)) {
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(root, "packages", directory, "package.json"), "utf8"),
    );
    versions.set(name, String(field(manifest, "version")));
  }
  return versions;
}

/**
 * Applies the changesets of a tree with the changelog off, then puts `.changeset/config.json`
 * back as it was, byte for byte, whether or not `changeset version` succeeded.
 * @param tree - The root of the tree; its manifests and changesets change.
 * @param changesetVersion - Runs `changeset version` in a directory.
 * @returns One `name before -> after` line per published package whose version changed.
 */
export function bumpTree(tree: string, changesetVersion: (cwd: string) => void): string[] {
  const before = versionsIn(tree);
  const configPath = path.join(tree, ".changeset/config.json");
  const config = readFileSync(configPath);
  writeFileSync(configPath, offlineConfig(config.toString("utf8")));
  try {
    changesetVersion(tree);
  } finally {
    writeFileSync(configPath, config);
  }
  return versionChanges(before, versionsIn(tree));
}

/** Runs git and returns its output. */
function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

/** The child running now, which a signal ends before the cleanup. */
let current: ChildProcess | undefined;

/** Runs a command with its output on this process's, and resolves with its exit code. */
async function run(command: string, args: readonly string[], cwd: string): Promise<number> {
  process.stdout.write(`\n$ ${[command, ...args].join(" ")}\n`);
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: "inherit" });
    current = child;
    child.once("error", reject);
    child.once("close", (code) => {
      current = undefined;
      resolve(code ?? 1);
    });
  });
}

/** Runs a command and throws when it fails. */
async function runOrThrow(command: string, args: readonly string[], cwd: string): Promise<void> {
  const code = await run(command, args, cwd);
  if (code !== 0) {
    throw new Error(`${[command, ...args].join(" ")} exited with ${code}`);
  }
}

async function main(): Promise<number> {
  const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  const changesets = pendingChangesets(
    git(["ls-tree", "-z", "--name-only", "HEAD", "--", ".changeset/"], root),
  );
  if (changesets.length === 0) {
    process.stdout.write("HEAD has no changeset, so the next release bumps nothing to test.\n");
    return 0;
  }
  process.stdout.write(`Changesets on HEAD: ${changesets.join(", ")}\n`);

  const scratch = mkdtempSync(path.join(tmpdir(), "hardhat-kms-bumped-"));
  const tree = path.join(scratch, "tree");
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    spawnSync("git", ["worktree", "remove", "--force", tree], { cwd: root, stdio: "ignore" });
    rmSync(scratch, { recursive: true, force: true });
    spawnSync("git", ["worktree", "prune"], { cwd: root, stdio: "ignore" });
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      current?.kill(signal);
      cleanup();
      process.exit(SIGNAL_EXIT_CODES[signal]);
    });
  }
  try {
    git(["worktree", "add", "--detach", tree, "HEAD"], root);
    await runOrThrow(pnpm, ["install", "--frozen-lockfile", "--ignore-scripts"], tree);
    const changes = bumpTree(tree, (cwd) => {
      process.stdout.write(`\n$ ${pnpm} exec changeset version (changelog off)\n`);
      execFileSync(pnpm, ["exec", "changeset", "version"], { cwd, stdio: "inherit" });
    });
    if (changes.length === 0) {
      process.stdout.write("The changesets bump no version, so there is nothing new to test.\n");
      return 0;
    }
    process.stdout.write(`\nTesting at the bumped versions: ${changes.join(", ")}\n`);
    // As `pnpm run version-packages` does, then a frozen install of the lockfile it wrote.
    await runOrThrow(pnpm, ["install", "--lockfile-only", "--ignore-scripts"], tree);
    await runOrThrow(pnpm, ["install", "--frozen-lockfile", "--ignore-scripts"], tree);
    const code = await run(pnpm, ["test"], tree);
    if (code !== 0) {
      process.stderr.write(
        `::error::pnpm test fails at the bumped versions (${changes.join(", ")}). A test that hard-codes a current version breaks the Version Packages pull request; read the version from the installed package.json instead.\n`,
      );
      return code;
    }
    process.stdout.write(`\npnpm test passes at the bumped versions (${changes.join(", ")}).\n`);
    return 0;
  } finally {
    cleanup();
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error: unknown) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
