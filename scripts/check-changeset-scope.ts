// The second half of the Changeset check of ci.yml. `pnpm changeset status` fails a pull request
// that changes a published package and adds no changeset. This script fails the opposite case: a
// pull request that changes nothing under `packages/` and adds a changeset, empty or not
// (CONTRIBUTING.md, Changesets). A changeset is a `.changeset/*.md` file other than README.md, so
// editing `.changeset/README.md` or `.changeset/config.json` is not adding one.
//
// The changes are those between the merge base of the base ref and HEAD, as `changeset status
// --since` reads them, so a pull request into `release/X.Y` is compared with that branch.
//
// Usage: node scripts/check-changeset-scope.ts --base=<ref>
//   <ref> is the pull request's base branch as fetched, such as `origin/main` or
//   `origin/release/1.0`. Exits 1, naming the added changesets, when no package changed.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** Where the rule is written. */
export const RULE_URL =
  "https://github.com/aelmanaa/hardhat-kms/blob/main/CONTRIBUTING.md#changesets";

/** One line of `git diff --name-status --no-renames`. */
export interface Change {
  /** The status letter: `A` added, `M` modified, `D` deleted, `T` type changed. */
  status: string;
  /** The path from the repository root, with `/` separators. */
  path: string;
}

/** What the check concluded. */
export interface ScopeResult {
  ok: boolean;
  /** Whether a file under `packages/` differs from the merge base. */
  packageChanged: boolean;
  /** The changesets the pull request adds, sorted. */
  addedChangesets: string[];
  /** The line to print. */
  message: string;
}

/**
 * Whether a path is a changeset: a Markdown file directly under `.changeset/`, other than the
 * README. Files under `.changeset/pre/` (pre mode) are moved there by `changeset version`, not
 * written by hand, so they do not count.
 * @param file - A path from the repository root.
 * @returns True for a changeset.
 */
export function isChangeset(file: string): boolean {
  return /^\.changeset\/[^/]+\.md$/.test(file) && file !== ".changeset/README.md";
}

/**
 * Reads the output of `git diff --name-status --no-renames -z`.
 * @param output - NUL-separated status and path pairs.
 * @returns The changes.
 */
export function parseNameStatus(output: string): Change[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") {
    fields.pop();
  }
  if (fields.length % 2 !== 0) {
    throw new Error(`git diff --name-status: odd number of fields (${fields.length})`);
  }
  const changes: Change[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index] ?? "";
    const file = fields[index + 1] ?? "";
    if (!/^[A-Z]$/.test(status) || file === "") {
      throw new Error(`git diff --name-status: unexpected entry ${JSON.stringify(status)}`);
    }
    changes.push({ status, path: file });
  }
  return changes;
}

/**
 * Decides whether a pull request's changesets fit its scope.
 * @param changes - What the pull request changes since the merge base.
 * @param base - The base ref, for the message.
 * @returns The verdict and the line to print.
 */
export function checkScope(changes: readonly Change[], base: string): ScopeResult {
  const packageChanged = changes.some((change) => change.path.startsWith("packages/"));
  const addedChangesets = changes
    .filter((change) => change.status === "A" && isChangeset(change.path))
    .map((change) => change.path)
    .toSorted();
  if (packageChanged || addedChangesets.length === 0) {
    return {
      ok: true,
      packageChanged,
      addedChangesets,
      message: packageChanged
        ? `A package changed since ${base}; changeset status checks its changeset.`
        : `Nothing under packages/ changed since ${base}, and no changeset was added.`,
    };
  }
  return {
    ok: false,
    packageChanged,
    addedChangesets,
    message: `This pull request changes nothing under packages/ since ${base}, so it carries no changeset, not even an empty one. Delete ${addedChangesets.join(", ")}. See ${RULE_URL}`,
  };
}

/**
 * Lists what HEAD changes since its merge base with a ref.
 * @param base - The base ref.
 * @param cwd - The repository.
 * @returns The changes, with a rename split into a deletion and an addition.
 */
export function changesSince(base: string, cwd: string): Change[] {
  const git = (args: readonly string[]): string =>
    execFileSync("git", [...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const mergeBase = git(["merge-base", base, "HEAD"]).trim();
  return parseNameStatus(git(["diff", "--name-status", "--no-renames", "-z", mergeBase, "HEAD"]));
}

function main(argv: readonly string[]): void {
  const { values } = parseArgs({ args: [...argv], options: { base: { type: "string" } } });
  const base = values.base;
  if (base === undefined || base === "") {
    throw new Error("--base is required: the pull request's base branch, such as origin/main");
  }
  const result = checkScope(changesSince(base, process.cwd()), base);
  if (!result.ok) {
    throw new Error(result.message);
  }
  process.stdout.write(`${result.message}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
