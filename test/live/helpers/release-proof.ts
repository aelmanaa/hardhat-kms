// Ties a `live-run` of `sepolia:<commit>` to the release promote.yml promotes: the commit must be
// one of this repository's, on `main` or on the release branch of the version's line, the last
// commit to change its `test/live/proof.json`, and that proof must cover AWS, Google Cloud and Azure with every record as its case
// expects, and the proof's `commit`, the commit the suite ran at, must be the tag's commit.
import { spawnSync } from "node:child_process";

import { CASES } from "../matrix.ts";
import { parseProof, type Proof, proofProblems } from "./proof.ts";

/** The proof file, at the proof commit. */
export const PROOF_PATH = "test/live/proof.json";

/** A full or abbreviated commit id, as the proof records it: 7 to 40 hexadecimal characters. */
const COMMIT = /^[0-9a-f]{7,40}$/;

/**
 * The commit rule: the proof's `commit` (the short hash the suite recorded) must name the tag's
 * commit, so it must be at least 7 hexadecimal characters and a prefix of the tag's full id.
 *
 * @param proofCommit - The proof's `commit` field.
 * @param tagCommit - The full id of the tag's commit.
 * @returns The problem, naming both commits, or undefined when the rule holds.
 */
export function commitProblem(proofCommit: string, tagCommit: string): string | undefined {
  if (COMMIT.test(proofCommit) && tagCommit.startsWith(proofCommit)) {
    return undefined;
  }
  return `the proof tested commit ${proofCommit}, but the tag is commit ${tagCommit}; run the Sepolia suite at the tag commit and commit its proof`;
}

/**
 * Records whose status is not the one their case expects (a transaction that should have mined
 * with status 1 but reverted, or the reverse), and records of a case the suite does not have.
 */
export function failedRecords(proof: Proof): string[] {
  const problems: string[] = [];
  for (const provider of proof.providers) {
    for (const record of provider.records) {
      const item = CASES.find((entry) => entry.id === record.case);
      if (item === undefined) {
        problems.push(`${provider.provider}: ${record.case} is not a case of the live suite`);
      } else if (record.status !== item.expect.status) {
        problems.push(
          `${provider.provider}: ${record.case} (${record.label}) is ${record.status}, not ${item.expect.status}`,
        );
      }
    }
  }
  return problems;
}

/**
 * Everything that keeps a proof from backing a release: the problems of `proofProblems` (chain,
 * the three providers each once, every live cell), failed records and the commit rule.
 *
 * @returns One message per problem; empty when the proof backs the release.
 */
export function releaseProofProblems(proof: Proof, tagCommit: string): string[] {
  const problems = [...proofProblems(proof), ...failedRecords(proof)];
  const commit = commitProblem(proof.commit, tagCommit);
  if (commit !== undefined) {
    problems.push(commit);
  }
  return problems;
}

/** Runs git in `cwd`; returns its trimmed stdout, or undefined when it exits non-zero. */
function git(cwd: string, args: readonly string[]): string | undefined {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** The branches a proof commit may be on: `main`, and the release branch of the version's line. */
export function proofBranches(version: string): string[] {
  const line = version.split(".").slice(0, 2).join(".");
  return ["main", `release/${line}`];
}

/** What `checkReleaseProof` found. */
export interface ReleaseProof {
  /** The full id of the proof commit. */
  proofCommit: string;
  /** The full id of the tag's commit. */
  tagCommit: string;
  /** The branch the proof commit is on. */
  branch: string;
  proof: Proof;
}

/**
 * Resolves the proof commit and the tag in the clone at `cwd`, reads the proof at that commit and
 * checks it against the tag. The clone needs the history of `origin/main` and, for a hotfix, of
 * `origin/release/X.Y`, and the tag `v<version>`.
 *
 * @param cwd - The clone.
 * @param version - The version promoted, without the v.
 * @param commit - The commit of `sepolia:<commit>`.
 * @returns What it found.
 * @throws With every reason when the proof does not back the release.
 */
export function checkReleaseProof(cwd: string, version: string, commit: string): ReleaseProof {
  if (!COMMIT.test(commit)) {
    throw new Error(`${JSON.stringify(commit)} is not a commit id of 7 to 40 hexadecimal digits`);
  }
  const proofCommit = git(cwd, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
  if (proofCommit === undefined) {
    throw new Error(`${commit} is not a commit in this repository`);
  }
  const tagCommit = git(cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/tags/v${version}^{commit}`,
  ]);
  if (tagCommit === undefined) {
    throw new Error(`tag v${version} is not in this clone`);
  }
  const branches = proofBranches(version);
  const branch = branches.find(
    (name) =>
      git(cwd, ["merge-base", "--is-ancestor", proofCommit, `refs/remotes/origin/${name}`]) !==
      undefined,
  );
  if (branch === undefined) {
    throw new Error(
      `${proofCommit} is on neither ${branches.map((name) => `origin/${name}`).join(" nor ")}`,
    );
  }
  const source = git(cwd, ["show", `${proofCommit}:${PROOF_PATH}`]);
  if (source === undefined) {
    throw new Error(`${proofCommit} has no ${PROOF_PATH}`);
  }
  // The input names the commit that added the proof, not a later one that carries it unchanged,
  // so the promotion record points at the proof's own commit.
  const changed = git(cwd, ["log", "-1", "--format=%H", proofCommit, "--", PROOF_PATH]);
  if (changed !== proofCommit) {
    throw new Error(
      `${proofCommit} did not change ${PROOF_PATH}; the proof it carries was committed in ${changed ?? "an unknown commit"}, so use sepolia:<that commit>`,
    );
  }
  let proof: Proof;
  try {
    proof = parseProof(source);
  } catch (error) {
    throw new Error(
      `${PROOF_PATH} at ${proofCommit} is not a proof: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const problems = releaseProofProblems(proof, tagCommit);
  if (problems.length > 0) {
    throw new Error(
      `${PROOF_PATH} at ${proofCommit} does not back v${version}:\n${problems.map((item) => `- ${item}`).join("\n")}`,
    );
  }
  return { proofCommit, tagCommit, branch, proof };
}
