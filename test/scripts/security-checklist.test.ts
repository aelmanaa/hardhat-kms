// The security checklist rule of pr-hygiene.yml (`scripts/security-checklist.ts`): the path
// matching, the parsing of the list page, the template and a pull request body, and the command's
// exit codes. Also checks the real list page against the repository, so a pattern that names a
// moved or deleted file fails. Runs in `pnpm test`, with no network. The stderr patterns use the m
// flag: Node 24.0.0 prints an ExperimentalWarning for type stripping before the script's output.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  checklistProblems,
  checkSecurityChecklist,
  LIST_PAGE,
  listedChanges,
  parseChangedFiles,
  parseChecklist,
  parseListedPaths,
  patternToRegExp,
  TEMPLATE,
} from "../../scripts/security-checklist.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "scripts/security-checklist.ts");

const LIST_PAGE_TEXT = `# Page

## Listed paths

\`\`\`text
packages/core/src/rpc/**
packages/core/src/signer/key.ts
packages/provider-*/src/adapter.ts

\`\`\`

## Next
`;

const TEMPLATE_TEXT = `Closes #

## Docs

## Security checklist

<!--
- [ ] **Hidden.** an example inside a comment
-->

- [ ] **Key.** The configured key signs.
- [ ] **Tests.** Tests cover it.
`;

function body(key: string, tests: string): string {
  return `Closes #1\n\n## Security checklist\n\n- [${key}] **Key.** The configured key signs.\n- [${tests}] **Tests.** Tests cover it.\n`;
}

describe("patternToRegExp", () => {
  it("matches an exact path and nothing longer or shorter", () => {
    const expression = patternToRegExp("packages/core/src/signer/key.ts");
    assert.equal(expression.test("packages/core/src/signer/key.ts"), true);
    assert.equal(expression.test("packages/core/src/signer/key.tsx"), false);
    assert.equal(expression.test("x/packages/core/src/signer/key.ts"), false);
    assert.equal(expression.test("packages/core/src/signer/keyXts"), false);
  });

  it("matches ** across directories, and * within one segment", () => {
    const deep = patternToRegExp("packages/core/src/rpc/**");
    assert.equal(deep.test("packages/core/src/rpc/dispatcher.ts"), true);
    assert.equal(deep.test("packages/core/src/rpc/a/b/c.ts"), true);
    assert.equal(deep.test("packages/core/src/rpc-old/dispatcher.ts"), false);
    const middle = patternToRegExp("packages/**/adapter.ts");
    assert.equal(middle.test("packages/adapter.ts"), true);
    assert.equal(middle.test("packages/a/b/adapter.ts"), true);
    const segment = patternToRegExp("packages/provider-*/src/adapter.ts");
    assert.equal(segment.test("packages/provider-aws/src/adapter.ts"), true);
    assert.equal(segment.test("packages/provider-/src/adapter.ts"), true);
    assert.equal(segment.test("packages/provider-aws/x/src/adapter.ts"), false);
  });
});

describe("parseListedPaths", () => {
  it("reads the code block under the heading, without blank lines", () => {
    assert.deepEqual(parseListedPaths(LIST_PAGE_TEXT), [
      "packages/core/src/rpc/**",
      "packages/core/src/signer/key.ts",
      "packages/provider-*/src/adapter.ts",
    ]);
  });

  it("fails without the heading, without a block in the section, or with an empty block", () => {
    assert.throws(() => parseListedPaths("# Page\n"), /has no "## Listed paths" heading/);
    assert.throws(
      () => parseListedPaths("## Listed paths\n\ntext\n\n## Next\n\n```text\na\n```\n"),
      /has no code block/,
    );
    assert.throws(() => parseListedPaths("## Listed paths\n\n```text\na\n"), /is not closed/);
    assert.throws(() => parseListedPaths("## Listed paths\n\n```text\n\n```\n"), /is empty/);
  });
});

describe("listedChanges", () => {
  it("returns the matching paths sorted and once each, and nothing when none match", () => {
    const patterns = parseListedPaths(LIST_PAGE_TEXT);
    assert.deepEqual(
      listedChanges(
        [
          "README.md",
          "packages/provider-gcp/src/adapter.ts",
          "packages/core/src/rpc/send.ts",
          "packages/core/src/rpc/send.ts",
        ],
        patterns,
      ),
      ["packages/core/src/rpc/send.ts", "packages/provider-gcp/src/adapter.ts"],
    );
    assert.deepEqual(listedChanges(["docs/a.md", "packages/core/test/rpc/x.ts"], patterns), []);
  });
});

describe("parseChangedFiles", () => {
  it("flattens the pages and counts a rename under both paths", () => {
    const json = JSON.stringify([
      [{ filename: "a.ts", status: "modified" }],
      [{ filename: "moved/b.ts", previous_filename: "packages/core/src/rpc/b.ts" }],
    ]);
    assert.deepEqual(parseChangedFiles(json, 2), [
      "a.ts",
      "moved/b.ts",
      "packages/core/src/rpc/b.ts",
    ]);
  });

  it("fails on a list shorter than the changed-file count, or of another shape", () => {
    assert.throws(
      () => parseChangedFiles(JSON.stringify([[{ filename: "a.ts" }]]), 2),
      /names 1 of the 2 changed files/,
    );
    assert.throws(() => parseChangedFiles("{}", 0), /not an array of pages/);
    assert.throws(() => parseChangedFiles("[{}]", 0), /page of the file list is not an array/);
    assert.throws(() => parseChangedFiles("[[{}]]", 0), /no string filename/);
    assert.throws(
      () => parseChangedFiles(JSON.stringify([[{ filename: "a", previous_filename: 1 }]]), 0),
      /no string filename/,
    );
  });
});

describe("parseChecklist", () => {
  it("reads labels and ticks, ignores comments, and stops at the next heading", () => {
    const text = `${body("x", "X")}\n## Other\n\n- [ ] **Later.** not in the section\n`;
    assert.deepEqual(parseChecklist(text), [
      { label: "Key.", ticked: true },
      { label: "Tests.", ticked: true },
    ]);
    assert.deepEqual(parseChecklist(TEMPLATE_TEXT), [
      { label: "Key.", ticked: false },
      { label: "Tests.", ticked: false },
    ]);
  });

  it("returns undefined without the section", () => {
    assert.equal(parseChecklist("Closes #1\n\n## Docs\n"), undefined);
  });
});

describe("checklistProblems", () => {
  const required = ["Key.", "Tests."];

  it("passes when every item is ticked, with a note after the label", () => {
    assert.deepEqual(
      checklistProblems(
        "## Security checklist\n\n- [x] **Key.** Not touched.\n* [X] **Tests.**\n",
        required,
      ),
      [],
    );
  });

  it("names a missing section, a missing item and an unticked item", () => {
    assert.deepEqual(checklistProblems("Closes #1", required), [
      'the pull request body has no "## Security checklist" section',
    ]);
    assert.deepEqual(
      checklistProblems(body(" ", "x").replace(/- \[ \] \*\*Key.*\n/, ""), required),
      ['the item "Key." is missing'],
    );
    assert.deepEqual(checklistProblems(body("x", " "), required), [
      'the item "Tests." is not ticked',
    ]);
  });
});

describe("checkSecurityChecklist", () => {
  const listed = ["packages/core/src/signer/key.ts", "docs/a.md"];

  it("asks nothing of a pull request that changes no listed path", () => {
    const result = checkSecurityChecklist({
      files: ["docs/a.md"],
      listPage: LIST_PAGE_TEXT,
      template: TEMPLATE_TEXT,
      body: "Closes #1",
    });
    assert.equal(result.passed, true);
    assert.match(result.lines.join("\n"), /The security checklist is not required/);
  });

  it("fails a listed change without the ticked checklist, and passes it with one", () => {
    const failed = checkSecurityChecklist({
      files: listed,
      listPage: LIST_PAGE_TEXT,
      template: TEMPLATE_TEXT,
      body: body("x", " "),
    });
    assert.equal(failed.passed, false);
    assert.deepEqual(failed.lines.slice(0, 3), [
      `This pull request changes 1 path(s) listed in ${LIST_PAGE}:`,
      "  packages/core/src/signer/key.ts",
      'Security checklist: the item "Tests." is not ticked.',
    ]);
    const passed = checkSecurityChecklist({
      files: listed,
      listPage: LIST_PAGE_TEXT,
      template: TEMPLATE_TEXT,
      body: body("x", "x"),
    });
    assert.equal(passed.passed, true);
  });

  it("fails when the template has no checklist", () => {
    assert.throws(
      () =>
        checkSecurityChecklist({
          files: listed,
          listPage: LIST_PAGE_TEXT,
          template: "## Docs\n",
          body: body("x", "x"),
        }),
      /has no items under "## Security checklist"/,
    );
  });
});

describe("the repository's list page and template", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((file) => file !== "");

  it("lists only patterns that match a tracked file", () => {
    const patterns = parseListedPaths(readFileSync(path.join(ROOT, LIST_PAGE), "utf8"));
    const stale = patterns.filter((pattern) => listedChanges(tracked, [pattern]).length === 0);
    assert.deepEqual(stale, []);
  });

  it("covers the signing and sending entry points", () => {
    const patterns = parseListedPaths(readFileSync(path.join(ROOT, LIST_PAGE), "utf8"));
    const core = "packages/hardhat-kms/src/internal";
    const entryPoints = [
      `${core}/signer/kms-signer.ts`,
      `${core}/signer/timeout.ts`,
      `${core}/signer/key-cache.ts`,
      `${core}/rpc/dispatcher.ts`,
      `${core}/rpc/send-guard.ts`,
      `${core}/rpc/transactions.ts`,
      `${core}/hook-handlers/network.ts`,
      `${core}/config/key-common.ts`,
      "packages/hardhat-kms-azure/src/internal/hook-handlers/kms.ts",
      `${core}/crypto/signature.ts`,
      "packages/hardhat-kms-aws/src/internal/adapter.ts",
      "packages/hardhat-kms-gcp/src/internal/adapter.ts",
      "packages/hardhat-kms-azure/src/internal/adapter.ts",
    ];
    assert.deepEqual(listedChanges(entryPoints, patterns), entryPoints.toSorted());
  });

  it("has a template checklist whose every item is unticked", () => {
    const items = parseChecklist(readFileSync(path.join(ROOT, TEMPLATE), "utf8"));
    assert.ok(items !== undefined && items.length >= 8, "the template has the checklist");
    assert.deepEqual(
      items.filter((item) => item.ticked),
      [],
    );
  });
});

function run(
  files: unknown,
  changedFiles: string,
  prBody: string,
): { status: number | null; stdout: string; stderr: string; summary: string } {
  const directory = mkdtempSync(path.join(tmpdir(), "security-checklist-test-"));
  try {
    const filesPath = path.join(directory, "files.json");
    const bodyPath = path.join(directory, "body.md");
    const listPath = path.join(directory, "list.md");
    const templatePath = path.join(directory, "template.md");
    const summaryPath = path.join(directory, "summary.md");
    writeFileSync(filesPath, JSON.stringify(files));
    writeFileSync(bodyPath, prBody);
    writeFileSync(listPath, LIST_PAGE_TEXT);
    writeFileSync(templatePath, TEMPLATE_TEXT);
    writeFileSync(summaryPath, "");
    const result = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "--files",
        filesPath,
        "--changed-files",
        changedFiles,
        "--body",
        bodyPath,
        "--list",
        listPath,
        "--template",
        templatePath,
        "--summary",
        summaryPath,
      ],
      { encoding: "utf8" },
    );
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      summary: readFileSync(summaryPath, "utf8"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("security-checklist.ts", () => {
  const listedFiles = [[{ filename: "packages/core/src/rpc/send.ts" }]];

  it("exits 0 when no listed path changed", () => {
    const result = run([[{ filename: "README.md" }]], "1", "Closes #1");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /The security checklist is not required/);
    assert.match(result.summary, /^### Security checklist\n/);
  });

  it("exits 1 with each problem when a listed path changed and an item is unticked", () => {
    const result = run(listedFiles, "1", body(" ", "x"));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^FAIL This pull request changes 1 path\(s\)/m);
    assert.match(result.stderr, /^ {2}packages\/core\/src\/rpc\/send\.ts$/m);
    assert.match(result.stderr, /the item "Key\." is not ticked/);
    assert.match(result.summary, /the item "Key\." is not ticked/);
  });

  it("exits 0 when a listed path changed and every item is ticked", () => {
    const result = run(listedFiles, "1", body("x", "x"));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Every item of the security checklist is ticked/);
  });

  it("exits 1 on a short file list, a bad count and missing arguments", () => {
    assert.match(
      run(listedFiles, "2", body("x", "x")).stderr,
      /^FAIL the file list names 1 of the 2/m,
    );
    assert.match(
      run(listedFiles, "two", "").stderr,
      /^FAIL --changed-files must be a whole number/m,
    );
    const missing = spawnSync(process.execPath, [SCRIPT, "--files", "x"], { encoding: "utf8" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /^FAIL usage: node scripts\/security-checklist\.ts/m);
  });
});
