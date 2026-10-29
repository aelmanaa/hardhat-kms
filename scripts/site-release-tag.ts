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

/** What the release branch of the tag looks like in this clone. */
export interface ReleaseBranch {
  /** The branch's commit, or undefined when the clone has no such branch. */
  commit: string | undefined;
  /** Whether the tag is an ancestor of the branch. */
  descends: boolean;
  /** The paths that differ between the tag and the branch. */
  changed: readonly string[];
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
 * What the site root is built from: the release branch when it holds only docs changes on top of
 * the tag, else the tag.
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
  const outside = branch.changed.filter((file) => !file.startsWith("docs/"));
  if (outside.length > 0) {
    return fromTag(
      `${name} changes ${outside.length === 1 ? "a file" : `${outside.length} files`} outside docs/ (${outside.slice(0, 3).join(", ")}), which npm latest does not have`,
    );
  }
  return {
    ref: branch.commit,
    reason: `${name} at ${branch.commit}: ${tag} with ${branch.changed.length} docs ${branch.changed.length === 1 ? "file" : "files"} backported`,
  };
}

/** Runs git and returns its trimmed output; throws when git exits non-zero. */
function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Reads the tag's release branch from the remote-tracking refs of this clone. */
function readReleaseBranch(tag: string): ReleaseBranch {
  const remote = `refs/remotes/origin/${releaseBranchOf(tag)}`;
  let commit: string;
  try {
    commit = git(["rev-parse", "--verify", "--quiet", `${remote}^{commit}`]);
  } catch {
    return { commit: undefined, descends: false, changed: [] };
  }
  let descends = true;
  try {
    git(["merge-base", "--is-ancestor", `refs/tags/${tag}`, commit]);
  } catch {
    descends = false;
  }
  const diff = git(["diff", "--name-only", `refs/tags/${tag}`, commit]);
  return { commit, descends, changed: diff === "" ? [] : diff.split("\n") };
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
