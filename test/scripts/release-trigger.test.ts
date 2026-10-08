// The first step of release-stage.yml (`scripts/release-trigger.ts`): which tag and mode a push or a
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
        channel: "stable",
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
        () =>
          readTrigger({
            channel: "stable",
            event: "push",
            refName,
            inputTag: undefined,
            inputDryRun: undefined,
          }),
        { message: /is not a vX\.Y\.Z release tag/ },
        refName,
      );
    }
  });

  it("makes a dispatch a dry run of a tag or of the branch", () => {
    for (const inputTag of ["v0.9.0", "none"]) {
      assert.deepEqual(
        readTrigger({
          channel: "stable",
          event: "workflow_dispatch",
          refName: "main",
          inputTag,
          inputDryRun: "true",
        }),
        { tag: inputTag, dryRun: true },
      );
    }
  });

  it("refuses a dispatch whose dry-run is anything but true", () => {
    for (const inputDryRun of ["false", "TRUE", "true\n", "", undefined]) {
      assert.throws(
        () =>
          readTrigger({
            channel: "stable",
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
            channel: "stable",
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
          channel: "stable",
          event: "schedule",
          refName: "main",
          inputTag: undefined,
          inputDryRun: undefined,
        }),
      { message: "release.yml runs on a tag push or a manual dispatch, not schedule" },
    );
  });
});

describe("readTrigger on the next channel", () => {
  it("makes a next tag push a release", () => {
    assert.deepEqual(
      readTrigger({
        channel: "next",
        event: "push",
        refName: "v2.0.0-next.0",
        inputTag: undefined,
        inputDryRun: undefined,
      }),
      { tag: "v2.0.0-next.0", dryRun: false },
    );
  });

  it("refuses a pushed tag without -next.N", () => {
    for (const refName of [
      "v2.0.0",
      "v2.0.0-beta.0",
      "v2.0.0-next",
      "v2.0.0-next.0.1",
      "v2.0.0-next.0+b",
      "2.0.0-next.0",
      "v2.0.0-next.0\nx",
      "",
    ]) {
      assert.throws(
        () =>
          readTrigger({
            channel: "next",
            event: "push",
            refName,
            inputTag: undefined,
            inputDryRun: undefined,
          }),
        { message: /is not a vX\.Y\.Z-next\.N release tag; release-next\.yml stages only next/ },
        refName,
      );
    }
  });

  it("makes a dispatch a dry run of a next tag or of the branch", () => {
    for (const inputTag of ["v2.0.0-next.3", "none"]) {
      assert.deepEqual(
        readTrigger({
          channel: "next",
          event: "workflow_dispatch",
          refName: "next",
          inputTag,
          inputDryRun: "true",
        }),
        { tag: inputTag, dryRun: true },
      );
    }
  });

  it("refuses a stable tag in a next dispatch, and a next tag in a stable one", () => {
    assert.throws(
      () =>
        readTrigger({
          channel: "next",
          event: "workflow_dispatch",
          refName: "next",
          inputTag: "v1.2.0",
          inputDryRun: "true",
        }),
      { message: /is not none or a vX\.Y\.Z-next\.N tag/ },
    );
    assert.throws(
      () =>
        readTrigger({
          channel: "stable",
          event: "workflow_dispatch",
          refName: "main",
          inputTag: "v2.0.0-next.0",
          inputDryRun: "true",
        }),
      { message: /is not none or a vX\.Y\.Z tag/ },
    );
  });

  it("names release-next.yml when the event is wrong", () => {
    assert.throws(
      () =>
        readTrigger({
          channel: "next",
          event: "schedule",
          refName: "next",
          inputTag: undefined,
          inputDryRun: undefined,
        }),
      { message: "release-next.yml runs on a tag push or a manual dispatch, not schedule" },
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
      channel: "stable",
      event: "workflow_dispatch",
      "ref-name": "main",
      tag: INJECTION,
      "dry-run": "true",
    });
    assert.equal(result.status, 1);
    assert.equal(result.output, "");
    assert.match(
      result.stderr,
      /^::error::tag "v0\.9\.0\\ndry-run=false\\njunk<<dry-run=true" is not none/m,
    );
  });

  it("writes exactly two lines for an accepted dispatch", () => {
    const result = run({
      channel: "stable",
      event: "workflow_dispatch",
      "ref-name": "main",
      tag: "none",
      "dry-run": "true",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, "tag=none\ndry-run=true\n");
  });

  it("writes the pushed next tag on the next channel", () => {
    const result = run({
      channel: "next",
      event: "push",
      "ref-name": "v2.0.0-next.0",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, "tag=v2.0.0-next.0\ndry-run=false\n");
  });

  it("writes nothing for a channel that is not stable or next", () => {
    for (const channel of ["beta", "latest", "next\ndist-tag=latest", ""]) {
      const result = run({ channel, event: "push", "ref-name": "v1.2.0" });
      assert.equal(result.status, 1, channel);
      assert.equal(result.output, "", channel);
      assert.match(result.stderr, /^::error::channel .* is not stable or next$/m, channel);
    }
  });

  it("keeps a value that starts with -- as a value, and refuses it", () => {
    const result = run({
      channel: "stable",
      event: "workflow_dispatch",
      "ref-name": "main",
      tag: "--output=/x",
      "dry-run": "true",
    });
    assert.equal(result.status, 1);
    assert.equal(result.output, "");
  });
});
