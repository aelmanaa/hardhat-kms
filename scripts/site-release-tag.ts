// The first step of pages.yml: picks the release tag the docs site root is built from, `vX.Y.Z`
// for the version on npm `latest` of hardhat-kms (decision 0024). The value from the registry only
// chooses which existing tag is built; anything but a stable `X.Y.Z` is refused, so a prerelease,
// a placeholder or npm's error never reaches the checkout, and nothing deploys. The workflow then
// checks that the tag exists before it checks it out.
//
// With `--ref-for=<tag>` it then picks what the root is built from (#603): the tip of
// `origin/release/X.Y` when that branch exists, descends from the tag and differs from it only
// under `docs/`, so a docs fix backported there reaches readers without a release; else the tag.
// A hotfix's code or version on the branch, not on npm yet, keeps the root on the tag. The branch
// is read from the remote-tracking ref the workflow fetched; the output is a commit, so the
// checkout builds exactly what was checked.
//
// Usage:
//   node scripts/site-release-tag.ts --output=<GITHUB_OUTPUT file>
//   node scripts/site-release-tag.ts --ref-for=vX.Y.Z --output=<GITHUB_OUTPUT file>
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { unwrapNpmView } from "./npm-view.ts";

/** The package whose `latest` the site root documents: the core, which every release carries. */
export const SITE_PACKAGE = "hardhat-kms";

/**
 * The release tag for the output of `npm view hardhat-kms dist-tags --json`.
 *
 * @param json - npm's output: the dist-tags object, or a one-element array holding it (npm 12).
 * @returns `v` and the version on `latest`.
 * @throws When the output is not a dist-tags object, or `latest` is not a stable `X.Y.Z`.
 */
export function siteReleaseTag(json: string): string {
  const command = `npm view ${SITE_PACKAGE} dist-tags`;
  const parsed = unwrapNpmView(command, JSON.parse(json));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || "error" in parsed) {
    throw new Error(`${command} printed ${JSON.stringify(parsed)}, not a dist-tags object`);
  }
  const latest: unknown = Reflect.get(parsed, "latest");
  if (typeof latest !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(latest)) {
    throw new Error(
      `latest of ${SITE_PACKAGE} is ${JSON.stringify(latest)}, not a stable X.Y.Z; the site root is built only from a release`,
    );
  }
  return `v${latest}`;
}

/** A file that differs between a tag and its release branch, from `git diff --raw`. */
export interface ChangedFile {
  path: string;
  /** The file's mode on the branch: `100644` for a regular file, `000000` once deleted. */
  mode: string;
}

/** What the release branch of the tag looks like in this clone. */
export interface ReleaseBranch {
  /** The branch's commit, or undefined when the clone has no such branch. */
  commit: string | undefined;
  /** Whether the tag is an ancestor of the branch. */
  descends: boolean;
  /** The files that differ between the tag and the branch; a rename is a deletion and an addition. */
  changed: readonly ChangedFile[];
}

/**
 * The release branch a tag belongs to: `release/X.Y` for `vX.Y.Z`.
 *
 * @param tag - A stable release tag.
 * @returns The branch name.
 * @throws When the tag is not `vX.Y.Z`.
 */
export function releaseBranchOf(tag: string): string {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if (match === null) {
    throw new Error(`${JSON.stringify(tag)} is not a vX.Y.Z tag`);
  }
  return `release/${match[1]}.${match[2]}`;
}

/**
 * The files a docs fix may change: Markdown pages and images. VitePress reads `docs/` as its
 * source, so a `.vue`, `.ts` or `.js` file there, or `<script>` in a public HTML file, would run.
 * Markdown can hold `<script setup>` too; a reviewer reads a backport like any pull request.
 */
const DOCS_FIX_FILE = /^docs\/.*\.(md|png|jpe?g|gif|webp|svg|ico)$/;

/**
 * What the site root is built from: the release branch when it holds only docs fixes on top of
 * the tag (regular Markdown and image files under `docs/`), else the tag.
 *
 * @param tag - The release tag of the version on npm `latest`.
 * @param branch - The tag's release branch in this clone.
 * @returns The ref to check out and why.
 */
export function siteRootRef(tag: string, branch: ReleaseBranch): { ref: string; reason: string } {
  const name = releaseBranchOf(tag);
  const fromTag = (why: string) => ({ ref: `refs/tags/${tag}`, reason: `${tag}: ${why}` });
  if (branch.commit === undefined) {
    return fromTag(`there is no ${name}`);
  }
  if (!branch.descends) {
    return fromTag(`${name} does not descend from ${tag}`);
  }
  const outside = branch.changed.filter((file) => !file.path.startsWith("docs/"));
  if (outside.length > 0) {
    return fromTag(
      `${name} changes ${outside.length === 1 ? "a file" : `${outside.length} files`} outside docs/ (${outside
        .slice(0, 3)
        .map((file) => JSON.stringify(file.path))
        .join(", ")}), which npm latest does not have`,
    );
  }
  const other = branch.changed.filter(
    (file) => file.mode !== "000000" && (file.mode !== "100644" || !DOCS_FIX_FILE.test(file.path)),
  );
  if (other.length > 0) {
    return fromTag(
      `${name} changes ${other.length === 1 ? "a file" : `${other.length} files`} under docs/ that ${other.length === 1 ? "is" : "are"} not a regular Markdown or image file (${other
        .slice(0, 3)
        .map((file) => `${JSON.stringify(file.path)} mode ${file.mode}`)
        .join(", ")})`,
    );
  }
  return {
    ref: branch.commit,
    reason: `${name} at ${branch.commit}: ${tag} with ${branch.changed.length} docs ${branch.changed.length === 1 ? "file" : "files"} backported`,
  };
}

/**
 * The files of `git diff --raw -z`: for each, `:<old mode> <new mode> <old> <new> <status>`, then
 * its path, each ended by NUL. With `--no-renames` every entry has one path.
 *
 * @param raw - git's output.
 * @returns The changed files with their mode on the newer side.
 */
export function parseRawDiff(raw: string): ChangedFile[] {
  const fields = raw.split("\0");
  const files: ChangedFile[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const meta = (fields[index] ?? "").split(" ");
    const file = fields[index + 1] ?? "";
    if (!(meta[0] ?? "").startsWith(":") || meta.length < 5 || file === "") {
      throw new Error(
        `git diff --raw printed an entry it should not: ${JSON.stringify(fields[index])}`,
      );
    }
    files.push({ path: file, mode: meta[1] ?? "" });
  }
  return files;
}

/** Runs git in `cwd` and returns its output; throws when git exits non-zero. */
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Reads the tag's release branch from the remote-tracking refs of a clone.
 *
 * @param tag - The release tag.
 * @param cwd - The clone; the current directory by default.
 * @returns The branch's commit, whether it descends from the tag, and what differs.
 */
export function readReleaseBranch(tag: string, cwd: string = process.cwd()): ReleaseBranch {
  const remote = `refs/remotes/origin/${releaseBranchOf(tag)}`;
  let commit: string;
  try {
    commit = git(["rev-parse", "--verify", "--quiet", `${remote}^{commit}`], cwd).trim();
  } catch {
    return { commit: undefined, descends: false, changed: [] };
  }
  let descends = true;
  try {
    git(["merge-base", "--is-ancestor", `refs/tags/${tag}`, commit], cwd);
  } catch {
    descends = false;
  }
  // No renames: a file moved into docs/ is also a deletion outside it. -z: paths as they are.
  const raw = git(["diff", "--raw", "--no-renames", "-z", `refs/tags/${tag}`, commit], cwd);
  return { commit, descends, changed: parseRawDiff(raw) };
}

function main(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: { output: { type: "string" }, "ref-for": { type: "string" } },
  });
  if (values.output === undefined || values.output === "") {
    throw new Error("--output is required: the GITHUB_OUTPUT file");
  }
  const refFor = values["ref-for"];
  if (refFor !== undefined) {
    const { ref, reason } = siteRootRef(refFor, readReleaseBranch(refFor));
    appendFileSync(values.output, `ref=${ref}\n`);
    process.stdout.write(`::notice::the site root builds from ${reason}\n`);
    return;
  }
  const tag = siteReleaseTag(
    execFileSync("npm", ["view", SITE_PACKAGE, "dist-tags", "--json"], { encoding: "utf8" }),
  );
  appendFileSync(values.output, `tag=${tag}\n`);
  process.stdout.write(`the site root documents ${tag}, the version on npm latest\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
