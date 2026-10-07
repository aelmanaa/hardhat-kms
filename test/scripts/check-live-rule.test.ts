// The command promote.yml runs for the live rule (`scripts/check-live-rule.ts`): its arguments,
// its exit codes and the line it appends to --summary. The rule itself is tested in
// registry-release.test.ts. Runs in `pnpm test`, with no network. The stderr patterns use the m
// flag: Node 24.0.0 prints an ExperimentalWarning for type stripping before the script's output.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/check-live-rule.ts",
);

function run(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("check-live-rule.ts", () => {
  it("passes an accepted combination and appends the rule line to --summary", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "check-live-rule-test-"));
    try {
      const summary = path.join(directory, "summary.md");
      const result = run(["1.2.0", "latest", "sepolia:abcdef0", "--summary", summary]);
      assert.equal(result.status, 0, result.stderr);
      const line =
        "1.2.0 is a minor; live-run sepolia at abcdef0 meets the live rule for target latest.";
      assert.equal(result.stdout, `${line}\n`);
      assert.equal(readFileSync(summary, "utf8"), `Live rule: ${line}\n\n`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("exits 1 with the rule's reason on a refused combination", () => {
    const result = run(["1.2.0", "latest", "fork"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^FAIL 1\.2\.0 is a minor; moving latest needs live-run sepolia/m);
  });

  it("exits 1 on a bad target, a bad live-run and a missing argument", () => {
    assert.match(
      run(["1.2.0", "promote", "fork"]).stderr,
      /^FAIL target must be verify or latest, not promote/m,
    );
    assert.match(
      run(["1.2.0", "verify", "sepolia:zz"]).stderr,
      /^FAIL live-run "sepolia:zz" is not/m,
    );
    const missing = run(["1.2.0", "verify"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /^FAIL usage: node scripts\/check-live-rule\.ts/m);
  });
});
