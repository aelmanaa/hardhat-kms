// Runs the test suite at the versions the next Version Packages pull request will set (#552). On
// main the manifests carry the last released version until that pull request merges, so a test
// that hard-codes the current version passes every run on main and fails only on the pull request
// itself, as the 1.2.0 one did (#519). This script applies the pending changesets in a scratch
// worktree of HEAD and runs `pnpm test` there; the checkout it runs from is left as it is.
//
// The steps follow `pnpm run version-packages`, which release-pr.yml runs: `changeset version`,
// then the lockfile. The scratch copy turns the changelog off, so `changeset version` reads no git
// history and needs no GitHub token; @changesets/changelog-github would ask the GitHub API for the
// pull request of every changeset. The tests do not read the changelogs.
//
// Usage: node scripts/test-bumped-versions.ts
//   Tests the committed HEAD, not uncommitted changes. Exits 0 without testing when HEAD has no
//   changeset or its changesets bump no version (empty changesets only), and with the exit code of
//   `pnpm test` otherwise.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isChangeset } from "./check-changeset-scope.ts";
import { readReleasePackages } from "./release-packages.ts";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

/**
 * Picks the changesets out of a list of paths.
 * @param files - Paths from the repository root, such as `git ls-tree` prints them.
 * @returns The changesets, sorted.
 */
export function pendingChangesets(files: readonly string[]): string[] {
  return files.filter((file) => isChangeset(file)).toSorted();
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

/** Runs a command in a directory with its output on this process's, and throws on a failure. */
function run(command: string, args: readonly string[], cwd: string): void {
  process.stdout.write(`\n$ ${[command, ...args].join(" ")}\n`);
  execFileSync(command, [...args], { cwd, stdio: "inherit" });
}

/** Runs git and returns its output. */
function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

function main(): number {
  const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  const changesets = pendingChangesets(
    git(["ls-tree", "--name-only", "HEAD", "--", ".changeset/"], root)
      .split("\n")
      .filter((line) => line !== ""),
  );
  if (changesets.length === 0) {
    process.stdout.write("HEAD has no changeset, so the next release bumps nothing to test.\n");
    return 0;
  }
  process.stdout.write(`Changesets on HEAD: ${changesets.join(", ")}\n`);

  const scratch = mkdtempSync(path.join(tmpdir(), "hardhat-kms-bumped-"));
  const tree = path.join(scratch, "tree");
  git(["worktree", "add", "--detach", tree, "HEAD"], root);
  try {
    run(pnpm, ["install", "--frozen-lockfile", "--ignore-scripts"], tree);
    const before = versionsIn(tree);
    const configPath = path.join(tree, ".changeset/config.json");
    writeFileSync(configPath, offlineConfig(readFileSync(configPath, "utf8")));
    run(pnpm, ["exec", "changeset", "version"], tree);
    const changes = versionChanges(before, versionsIn(tree));
    if (changes.length === 0) {
      process.stdout.write("The changesets bump no version, so there is nothing new to test.\n");
      return 0;
    }
    process.stdout.write(`\nTesting at the bumped versions: ${changes.join(", ")}\n`);
    // As `pnpm run version-packages` does, then a frozen install of the lockfile it wrote.
    run(pnpm, ["install", "--lockfile-only", "--ignore-scripts"], tree);
    run(pnpm, ["install", "--frozen-lockfile", "--ignore-scripts"], tree);
    process.stdout.write(`\n$ ${pnpm} test\n`);
    const result = spawnSync(pnpm, ["test"], { cwd: tree, stdio: "inherit" });
    if (result.status !== 0) {
      process.stderr.write(
        `::error::pnpm test fails at the bumped versions (${changes.join(", ")}). A test that hard-codes a current version breaks the Version Packages pull request; read the version from the installed package.json instead.\n`,
      );
      return result.status ?? 1;
    }
    process.stdout.write(`\npnpm test passes at the bumped versions (${changes.join(", ")}).\n`);
    return 0;
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", tree], { cwd: root, stdio: "ignore" });
    rmSync(scratch, { recursive: true, force: true });
    spawnSync("git", ["worktree", "prune"], { cwd: root, stdio: "ignore" });
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error: unknown) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
