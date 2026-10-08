// The proof check of promote.yml (`helpers/release-proof.ts` and `check-release-proof.ts`): a
// `sepolia:<commit>` value must name a commit of this repository on main or on the release branch,
// whose test/live/proof.json covers the three providers with every record as its case expects and
// tested the tag's commit. The git cases run in a scratch repository. Runs in `pnpm test`, with no
// keys and no network. The stderr patterns use the m flag: Node 24.0.0 prints an
// ExperimentalWarning for type stripping before the script's output.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parseProof, type Proof } from "./helpers/proof.ts";
import {
  checkReleaseProof,
  commitProblem,
  failedRecords,
  proofBranches,
  releaseProofProblems,
} from "./helpers/release-proof.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "check-release-proof.ts");
/** test/live/proof.json at 32b13734f6c7c263a9a59697528e471b74ca1d96, the proof for 0.10.0. */
const PROOF_0_10_0 = readFileSync(path.join(here, "fixtures/proof-0.10.0.json"), "utf8");
/** The commit of tag v0.10.0. */
const TAG_0_10_0 = "953a9e31bd966b142ebbe93d8decae4f618ac2d5";

const realProof = (): Proof => parseProof(PROOF_0_10_0);

describe("the proof's commit rule and contents", () => {
  it("passes the real 0.10.0 proof against the v0.10.0 tag commit", () => {
    const proof = realProof();
    assert.equal(proof.commit, "953a9e3");
    assert.deepEqual(releaseProofProblems(proof, TAG_0_10_0), []);
  });

  it("refuses a proof of another commit, naming both commits", () => {
    const other = "1aeecd5f00000000000000000000000000000000";
    const message = `the proof tested commit 953a9e3, but the tag is commit ${other}; run the Sepolia suite at the tag commit and commit its proof`;
    assert.equal(commitProblem("953a9e3", other), message);
    assert.deepEqual(releaseProofProblems(realProof(), other), [message]);
    // Too short to name one commit, and not hexadecimal.
    assert.match(commitProblem("953a9e", TAG_0_10_0) ?? "", /tested commit 953a9e, but/);
    assert.match(commitProblem("", TAG_0_10_0) ?? "", /tested commit , but/);
    assert.equal(commitProblem(TAG_0_10_0, TAG_0_10_0), undefined);
  });

  it("refuses a proof that lacks a provider", () => {
    const proof = realProof();
    proof.providers = proof.providers.filter((provider) => provider.provider !== "azure");
    assert.deepEqual(releaseProofProblems(proof, TAG_0_10_0), [
      "the proof lists azure 0 times, not once",
    ]);
  });

  it("refuses a proof with a failed record", () => {
    const proof = realProof();
    const gcp = proof.providers.find((provider) => provider.provider === "gcp");
    assert.ok(gcp !== undefined);
    gcp.records = gcp.records.map((record) =>
      record.case === "call-eip1559" ? { ...record, status: "reverted" } : record,
    );
    assert.deepEqual(failedRecords(proof), [
      "gcp: call-eip1559 (add(1) with 1 wei) is reverted, not success",
    ]);
    const problems = releaseProofProblems(proof, TAG_0_10_0);
    assert.ok(problems.includes("gcp: call-eip1559 (add(1) with 1 wei) is reverted, not success"));
    assert.ok(problems.some((item) => item.startsWith("gcp: call/eip1559: no success record")));
  });

  it("refuses a record of a case the suite does not have", () => {
    const proof = realProof();
    const [first] = proof.providers;
    const [record] = first?.records ?? [];
    assert.ok(first !== undefined && record !== undefined);
    first.records = [...first.records, { ...record, case: "made-up" }];
    assert.deepEqual(failedRecords(proof), [
      `${first.provider}: made-up is not a case of the live suite`,
    ]);
  });

  it("allows main and the release branch of the version's line", () => {
    assert.deepEqual(proofBranches("1.2.3"), ["main", "release/1.2"]);
  });
});

/** Runs git in `cwd` and returns its trimmed stdout; fails the test on a non-zero exit. */
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** Commits `files` (path to text) on the current branch and returns the full commit id. */
function commit(cwd: string, message: string, files: Record<string, string> = {}): string {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), text);
  }
  git(cwd, "add", "--all");
  git(cwd, "commit", "--allow-empty", "--quiet", "--message", message);
  return git(cwd, "rev-parse", "HEAD");
}

/** The real 0.10.0 proof with its `commit` set to a scratch repository's tag commit. */
function proofFor(tagCommit: string, edit: (proof: Proof) => void = () => {}): string {
  const proof = realProof();
  proof.commit = tagCommit.slice(0, 7);
  edit(proof);
  return `${JSON.stringify(proof, null, 2)}\n`;
}

function run(
  cwd: string,
  args: readonly string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("check-release-proof.ts in a clone", () => {
  let repo = "";
  let tag = "";
  let good = "";
  let noProof = "";
  let incomplete = "";
  let offBranch = "";
  let hotfix = "";

  before(() => {
    repo = mkdtempSync(path.join(tmpdir(), "release-proof-test-"));
    git(repo, "init", "--quiet", "--initial-branch=main");
    git(repo, "config", "user.email", "test@example.invalid");
    git(repo, "config", "user.name", "test");
    git(repo, "config", "commit.gpgsign", "false");
    git(repo, "config", "tag.gpgsign", "false");
    tag = commit(repo, "release 1.2.0", { "README.md": "1.2.0\n" });
    git(repo, "tag", "v1.2.0");
    noProof = commit(repo, "no proof yet");
    incomplete = commit(repo, "a proof without gcp", {
      "test/live/proof.json": proofFor(tag, (proof) => {
        proof.providers = proof.providers.filter((provider) => provider.provider !== "gcp");
      }),
    });
    good = commit(repo, "the proof", { "test/live/proof.json": proofFor(tag) });
    git(repo, "update-ref", "refs/remotes/origin/main", good);
    // A commit on a branch that is neither main nor release/1.2.
    git(repo, "checkout", "--quiet", "-b", "feature", tag);
    offBranch = commit(repo, "the proof, off main", { "test/live/proof.json": proofFor(tag) });
    // A hotfix of the 1.1 line, proven on release/1.1.
    git(repo, "switch", "--quiet", "--orphan", "release/1.1");
    const hotfixTag = commit(repo, "release 1.1.1", { "README.md": "1.1.1\n" });
    git(repo, "tag", "v1.1.1");
    hotfix = commit(repo, "the hotfix proof", { "test/live/proof.json": proofFor(hotfixTag) });
    git(repo, "update-ref", "refs/remotes/origin/release/1.1", hotfix);
  });

  after(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("passes a proof on main that tested the tag commit, and appends it to --summary", () => {
    const summary = path.join(repo, "..", `${path.basename(repo)}-summary.md`);
    try {
      const result = run(repo, ["1.2.0", `sepolia:${good}`, "--summary", summary]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        result.stdout,
        new RegExp(
          `^test/live/proof\\.json at ${good} \\(on origin/main\\) tested commit ${tag.slice(0, 7)}, the commit of tag v1\\.2\\.0 \\(${tag}\\), on chain 11155111: aws 18 records, gcp 18 records, azure 18 records`,
        ),
      );
      assert.equal(readFileSync(summary, "utf8"), `Sepolia proof: ${result.stdout.trim()}\n\n`);
    } finally {
      rmSync(summary, { force: true });
    }
  });

  it("accepts the abbreviated proof commit", () => {
    assert.equal(run(repo, ["1.2.0", `sepolia:${good.slice(0, 7)}`]).status, 0);
  });

  it("passes a hotfix proof on the release branch of its line", () => {
    const result = run(repo, ["1.1.1", `sepolia:${hotfix}`]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\(on origin\/release\/1\.1\)/);
  });

  it("refuses a commit that does not exist", () => {
    const result = run(repo, ["1.2.0", "sepolia:deadbee"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^FAIL deadbee is not a commit in this repository$/m);
  });

  it("refuses a commit without test/live/proof.json", () => {
    const result = run(repo, ["1.2.0", `sepolia:${noProof}`]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`^FAIL ${noProof} has no test/live/proof\\.json$`, "m"));
  });

  it("refuses an incomplete proof, with each reason", () => {
    const result = run(repo, ["1.2.0", `sepolia:${incomplete}`]);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /does not back v1\.2\.0:\n- the proof lists gcp 0 times, not once$/m,
    );
  });

  it("refuses a proof of another commit than the tag's, naming both", () => {
    // The 1.2.0 proof, on main, read for the 1.1.1 hotfix: main is allowed, the commit rule is not met.
    const result = run(repo, ["1.1.1", `sepolia:${good}`]);
    assert.equal(result.status, 1);
    const hotfixTag = git(repo, "rev-parse", "v1.1.1^{commit}");
    assert.match(
      result.stderr,
      new RegExp(
        `^- the proof tested commit ${tag.slice(0, 7)}, but the tag is commit ${hotfixTag};`,
        "m",
      ),
    );
  });

  it("refuses a commit on neither main nor the release branch", () => {
    const result = run(repo, ["1.2.0", `sepolia:${offBranch}`]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is on neither origin\/main nor origin\/release\/1\.2$/m);
  });

  it("refuses a missing tag, a bad version, a bad live-run and a missing argument", () => {
    assert.match(
      run(repo, ["9.9.9", `sepolia:${good}`]).stderr,
      /^FAIL tag v9\.9\.9 is not in this clone$/m,
    );
    assert.match(
      run(repo, ["v1.2.0", `sepolia:${good}`]).stderr,
      /^FAIL version must be an exact X\.Y\.Z/m,
    );
    assert.match(run(repo, ["1.2.0", "sepolia:zz"]).stderr, /^FAIL live-run "sepolia:zz" is not/m);
    assert.match(run(repo, ["1.2.0"]).stderr, /^FAIL usage: node test\/live\/check-release-proof/m);
    assert.throws(() => checkReleaseProof(repo, "1.2.0", "--all"), {
      message: '"--all" is not a commit id of 7 to 40 hexadecimal digits',
    });
  });

  it("has no proof to check for fork and none", () => {
    for (const value of ["fork", "none"]) {
      const result = run(repo, ["1.2.0", value]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `live-run ${value}: no Sepolia proof to check.\n`);
    }
  });
});
