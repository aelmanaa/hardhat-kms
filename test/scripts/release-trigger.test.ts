// The first step of release.yml (`scripts/release-trigger.ts`): which tag and mode a push or a
// dispatch gets, and that a refused input writes nothing to GITHUB_OUTPUT, so a multi-line input
// cannot add or override an output. Runs in `pnpm test`, with no network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { readTrigger } from "../../scripts/release-trigger.ts";

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/release-trigger.ts",
);

/** A dispatch input that tries to flip dry-run to false through GITHUB_OUTPUT's line format. */
const INJECTION = "v0.9.0\ndry-run=false\njunk<<dry-run=true";

describe("readTrigger", () => {
  it("makes a tag push a release of that tag", () => {
    assert.deepEqual(
      readTrigger({
        event: "push",
        refName: "v1.2.0",
        inputTag: undefined,
        inputDryRun: undefined,
      }),
      {
        tag: "v1.2.0",
        dryRun: false,
      },
    );
  });

  it("refuses a pushed tag that is not vX.Y.Z", () => {
    for (const refName of ["v1.2.0-rc.1", "v1.2", "1.2.0", "v1.2.0\nx", ""]) {
      assert.throws(
        () => readTrigger({ event: "push", refName, inputTag: undefined, inputDryRun: undefined }),
        { message: /is not a vX\.Y\.Z release tag/ },
        refName,
      );
    }
  });

  it("makes a dispatch a dry run of a tag or of the branch", () => {
    for (const inputTag of ["v0.9.0", "none"]) {
      assert.deepEqual(
        readTrigger({ event: "workflow_dispatch", refName: "main", inputTag, inputDryRun: "true" }),
        { tag: inputTag, dryRun: true },
      );
    }
  });

  it("refuses a dispatch whose dry-run is anything but true", () => {
    for (const inputDryRun of ["false", "TRUE", "true\n", "", undefined]) {
      assert.throws(
        () =>
          readTrigger({
            event: "workflow_dispatch",
            refName: "main",
            inputTag: "none",
            inputDryRun,
          }),
        { message: /A release starts only from a pushed signed tag/ },
      );
    }
  });

  it("refuses a dispatch tag that is not one whole vX.Y.Z or none", () => {
    for (const inputTag of [INJECTION, "none\nv1.0.0", "v1.0.0 ", "v1.0.0-rc.1", "main", ""]) {
      assert.throws(
        () =>
          readTrigger({
            event: "workflow_dispatch",
            refName: "main",
            inputTag,
            inputDryRun: "true",
          }),
        { message: /is not none or a vX\.Y\.Z tag/ },
        JSON.stringify(inputTag),
      );
    }
  });

  it("refuses another event", () => {
    assert.throws(
      () =>
        readTrigger({
          event: "schedule",
          refName: "main",
          inputTag: undefined,
          inputDryRun: undefined,
        }),
      { message: "release.yml runs on a tag push or a manual dispatch, not schedule" },
    );
  });
});

/** Runs the script as release.yml does and returns its exit code, its stderr and GITHUB_OUTPUT. */
function run(values: Record<string, string>): {
  status: number | null;
  output: string;
  stderr: string;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "release-trigger-test-"));
  try {
    const output = path.join(directory, "github-output");
    writeFileSync(output, "");
    const args = Object.entries({ ...values, output }).map(([name, value]) => `--${name}=${value}`);
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    return { status: result.status, output: readFileSync(output, "utf8"), stderr: result.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("release-trigger.ts as the workflow runs it", () => {
  it("writes nothing to GITHUB_OUTPUT for the multi-line injection payload", () => {
    const result = run({
      event: "workflow_dispatch",
      "ref-name": "main",
      tag: INJECTION,
      "dry-run": "true",
    });
    assert.equal(result.status, 1);
    assert.equal(result.output, "");
    assert.match(
      result.stderr,
      /^::error::tag "v0\.9\.0\\ndry-run=false\\njunk<<dry-run=true" is not none/,
    );
  });

  it("writes exactly two lines for an accepted dispatch", () => {
    const result = run({
      event: "workflow_dispatch",
      "ref-name": "main",
      tag: "none",
      "dry-run": "true",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, "tag=none\ndry-run=true\n");
  });

  it("keeps a value that starts with -- as a value, and refuses it", () => {
    const result = run({
      event: "workflow_dispatch",
      "ref-name": "main",
      tag: "--output=/x",
      "dry-run": "true",
    });
    assert.equal(result.status, 1);
    assert.equal(result.output, "");
  });
});
