// The security checklist rule of pr-hygiene.yml (`scripts/security-checklist.ts`): the path
// matching, the parsing of the list page, the template and a pull request body, which lists a set
// of changed files requires, and the command's exit codes. Also checks the real list page against the repository, so a pattern that names a
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
  pageListNames,
  parseListedPaths,
  patternToRegExp,
  TEMPLATE,
  templateLists,
} from "../../scripts/security-checklist.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "scripts/security-checklist.ts");

const LIST_PAGE_TEXT = `# Page

## Signing

\`\`\`text
packages/core/src/rpc/**
packages/core/src/signer/key.ts
packages/provider-*/src/adapter.ts

\`\`\`

| Area | Paths |

## Release

\`\`\`text
.github/workflows/release.yml
packages/*/package.json
\`\`\`

## Next
`;

const TEMPLATE_TEXT = `Closes #

## Docs

## Security checklist

<!--
- [ ] **Hidden.** an example inside a comment
-->

### Signing

- [ ] **Key.** The configured key signs.
- [ ] **Tests.** Tests cover it.

### Release

- [ ] **Published.** Only the built files.
`;

function body(key: string, tests: string, published?: string): string {
  const release =
    published === undefined ? "" : `\n### Release\n\n- [${published}] **Published.**\n`;
  return `Closes #1\n\n## Security checklist\n\n- [${key}] **Key.** The configured key signs.\n- [${tests}] **Tests.** Tests cover it.\n${release}`;
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
  it("reads the first code block of the named section, without blank lines", () => {
    assert.deepEqual(parseListedPaths(LIST_PAGE_TEXT, "Signing"), [
      "packages/core/src/rpc/**",
      "packages/core/src/signer/key.ts",
      "packages/provider-*/src/adapter.ts",
    ]);
    assert.deepEqual(parseListedPaths(LIST_PAGE_TEXT, "Release"), [
      ".github/workflows/release.yml",
      "packages/*/package.json",
    ]);
  });

  it("fails without the section, without a block in the section, or with an empty block", () => {
    assert.throws(() => parseListedPaths("# Page\n", "Signing"), /has no "## Signing" heading/);
    assert.throws(
      () => parseListedPaths("## Release and supply chain\n\n```text\na\n```\n", "Release"),
      /has no "## Release" heading/,
    );
    assert.throws(
      () =>
        parseListedPaths(
          "## Signing\n\n```mermaid\nflowchart\n```\n\n```text\na\n```\n",
          "Signing",
        ),
      /the first code block under "## Signing" .* does not open with ```text/,
    );
    assert.throws(
      () => parseListedPaths("## Signing\n\ntext\n\n## Next\n\n```text\na\n```\n", "Signing"),
      /"## Signing" in .* has no code block/,
    );
    assert.throws(() => parseListedPaths("## Signing\n\n```text\na\n", "Signing"), /is not closed/);
    assert.throws(() => parseListedPaths("## Signing\n\n```text\n\n```\n", "Signing"), /is empty/);
  });
});

describe("pageListNames", () => {
  it("names each ## section that holds a text block, and no other", () => {
    assert.deepEqual(pageListNames(LIST_PAGE_TEXT), ["Signing", "Release"]);
    assert.deepEqual(pageListNames("## A\n\n```sh\nx\n```\n\n## B\n\ntext\n"), []);
  });
});

describe("listedChanges", () => {
  it("returns the matching paths sorted and once each, and nothing when none match", () => {
    const patterns = parseListedPaths(LIST_PAGE_TEXT, "Signing");
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
  it("reads labels, ticks and list headings, ignores comments, and stops at the next heading", () => {
    const text = `${body("x", "X")}\n## Other\n\n- [ ] **Later.** not in the section\n`;
    assert.deepEqual(parseChecklist(text), [
      { label: "Key.", ticked: true, list: undefined },
      { label: "Tests.", ticked: true, list: undefined },
    ]);
    assert.deepEqual(parseChecklist(TEMPLATE_TEXT), [
      { label: "Key.", ticked: false, list: "Signing" },
      { label: "Tests.", ticked: false, list: "Signing" },
      { label: "Published.", ticked: false, list: "Release" },
    ]);
  });

  it("returns undefined without the section", () => {
    assert.equal(parseChecklist("Closes #1\n\n## Docs\n"), undefined);
  });
});

describe("templateLists", () => {
  it("groups the items by their list heading, in template order", () => {
    assert.deepEqual(templateLists(TEMPLATE_TEXT), [
      { name: "Signing", labels: ["Key.", "Tests."] },
      { name: "Release", labels: ["Published."] },
    ]);
  });

  it("fails on no items, an item without a list heading, or a label used twice", () => {
    assert.throws(() => templateLists("## Docs\n"), /has no items under "## Security checklist"/);
    assert.throws(
      () => templateLists("## Security checklist\n\n- [ ] **Key.** a\n"),
      /the item "Key\." in .* has no "###" list heading above it/,
    );
    assert.throws(
      () =>
        templateLists(
          "## Security checklist\n\n### Signing\n\n- [ ] **Key.** a\n\n### Release\n\n- [ ] **Key.** b\n",
        ),
      /the item "Key\." appears twice/,
    );
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

function check(
  files: readonly string[],
  prBody: string,
): ReturnType<typeof checkSecurityChecklist> {
  return checkSecurityChecklist({
    files,
    listPage: LIST_PAGE_TEXT,
    template: TEMPLATE_TEXT,
    body: prBody,
  });
}

describe("checkSecurityChecklist", () => {
  const signing = ["packages/core/src/signer/key.ts", "docs/a.md"];
  const release = [".github/workflows/release.yml", "packages/core/package.json"];

  it("asks nothing of a pull request that changes no listed path", () => {
    const result = check(["docs/a.md"], "Closes #1");
    assert.equal(result.passed, true);
    assert.match(result.lines.join("\n"), /The security checklist is not required/);
  });

  it("fails a signing change without the ticked signing items, and passes it with them", () => {
    const failed = check(signing, body("x", " "));
    assert.equal(failed.passed, false);
    assert.deepEqual(failed.lines.slice(0, 3), [
      `This pull request changes 1 path(s) of the "Signing" list in ${LIST_PAGE}:`,
      "  packages/core/src/signer/key.ts",
      'Security checklist: the item "Tests." is not ticked.',
    ]);
    assert.match(failed.lines.at(-1) ?? "", /Copy the "Signing" items/);
    const passed = check(signing, body("x", "x"));
    assert.equal(passed.passed, true);
    assert.match(passed.lines.at(-1) ?? "", /Every item of the "Signing" checklist is ticked/);
  });

  it("requires only the release items of a change that touches only release paths", () => {
    const failed = check(release, "Closes #1\n\n## Security checklist\n\n- [ ] **Published.**\n");
    assert.equal(failed.passed, false);
    assert.deepEqual(failed.lines, [
      `This pull request changes 2 path(s) of the "Release" list in ${LIST_PAGE}:`,
      "  .github/workflows/release.yml",
      "  packages/core/package.json",
      'Security checklist: the item "Published." is not ticked.',
      `Copy the "Release" items of the "## Security checklist" section of ${TEMPLATE} into the description and tick each item once it holds.`,
    ]);
    const passed = check(release, "Closes #1\n\n## Security checklist\n\n- [x] **Published.**\n");
    assert.equal(passed.passed, true);
  });

  it("does not accept the signing items for a release change", () => {
    const result = check(release, body("x", "x"));
    assert.equal(result.passed, false);
    assert.deepEqual(
      result.lines.filter((line) => line.startsWith("Security checklist:")),
      ['Security checklist: the item "Published." is missing.'],
    );
  });

  it("requires both sets of items when a change touches both lists", () => {
    const files = [...signing, ...release];
    const onlySigning = check(files, body("x", "x"));
    assert.equal(onlySigning.passed, false);
    assert.deepEqual(
      onlySigning.lines.filter((line) => !line.startsWith("  ")),
      [
        `This pull request changes 1 path(s) of the "Signing" list in ${LIST_PAGE}:`,
        `This pull request changes 2 path(s) of the "Release" list in ${LIST_PAGE}:`,
        'Security checklist: the item "Published." is missing.',
        `Copy the "Signing" and "Release" items of the "## Security checklist" section of ${TEMPLATE} into the description and tick each item once it holds.`,
      ],
    );
    const onlyRelease = check(files, body(" ", " ", "x"));
    assert.deepEqual(
      onlyRelease.lines.filter((line) => line.startsWith("Security checklist:")),
      [
        'Security checklist: the item "Key." is not ticked.',
        'Security checklist: the item "Tests." is not ticked.',
      ],
    );
    const both = check(files, body("x", "x", "x"));
    assert.equal(both.passed, true);
    assert.match(both.lines.at(-1) ?? "", /Every item of the "Signing" and "Release" checklist/);
  });

  it("fails closed when a page list loses its template heading or items", () => {
    const releaseHeading = "### Release\n\n";
    const drifts: [string, string][] = [
      ["heading deleted", TEMPLATE_TEXT.replace(releaseHeading, "")],
      ["items deleted", TEMPLATE_TEXT.replace("- [ ] **Published.** Only the built files.\n", "")],
      ["heading at ####", TEMPLATE_TEXT.replace(releaseHeading, "#### Release\n\n")],
      ["heading at ##", TEMPLATE_TEXT.replace(releaseHeading, "## Release\n\n")],
    ];
    for (const [drift, template] of drifts) {
      assert.throws(
        () =>
          checkSecurityChecklist({
            files: [".github/workflows/release.yml"],
            listPage: LIST_PAGE_TEXT,
            template,
            body: "Closes #1",
          }),
        /"Release" with no "###" heading and items|the list "Release" in .* has no items/,
        drift,
      );
    }
  });

  it("fails when a template heading has no items", () => {
    assert.throws(
      () => templateLists(`${TEMPLATE_TEXT}\n### Empty\n`),
      /the list "Empty" in .* has no items/,
    );
  });

  it("fails when the template has no checklist or names a list the page lacks", () => {
    assert.throws(
      () =>
        checkSecurityChecklist({
          files: signing,
          listPage: LIST_PAGE_TEXT,
          template: "## Docs\n",
          body: body("x", "x"),
        }),
      /has no items under "## Security checklist"/,
    );
    assert.throws(
      () =>
        checkSecurityChecklist({
          files: signing,
          listPage: LIST_PAGE_TEXT,
          template: `${TEMPLATE_TEXT}\n### Other\n\n- [ ] **Other.** a\n`,
          body: body("x", "x"),
        }),
      /has no "## Other" heading/,
    );
  });
});

describe("the repository's list page and template", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((file) => file !== "");

  const listPage = readFileSync(path.join(ROOT, LIST_PAGE), "utf8");
  const lists = templateLists(readFileSync(path.join(ROOT, TEMPLATE), "utf8"));

  it("has the two lists, each with a section on the list page", () => {
    assert.deepEqual(
      lists.map((list) => list.name),
      ["Signing and sending", "Release and supply chain"],
    );
    assert.deepEqual(
      lists.map((list) => list.labels.length),
      [8, 3],
    );
    assert.deepEqual(pageListNames(listPage), ["Signing and sending", "Release and supply chain"]);
    for (const list of lists) {
      assert.ok(parseListedPaths(listPage, list.name).length > 0, list.name);
    }
  });

  it("lists only patterns that match a tracked file", () => {
    const patterns = lists.flatMap((list) => parseListedPaths(listPage, list.name));
    const stale = patterns.filter((pattern) => listedChanges(tracked, [pattern]).length === 0);
    assert.deepEqual(stale, []);
  });

  it("covers the signing and sending entry points", () => {
    const patterns = parseListedPaths(listPage, "Signing and sending");
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
      `${core}/error-catalog.ts`,
    ];
    assert.deepEqual(listedChanges(entryPoints, patterns), entryPoints.toSorted());
  });

  it("covers the release workflows, the release gate, the keys and the manifests", () => {
    const patterns = parseListedPaths(listPage, "Release and supply chain");
    const releasePaths = [
      ".github/workflows/release.yml",
      ".github/workflows/promote.yml",
      ".github/workflows/release-pr.yml",
      ".github/workflows/pr-hygiene.yml",
      ".github/release-keys/aelmanaa.asc",
      ".github/ruleset-protect-tags.json",
      ".github/CODEOWNERS",
      "packages/hardhat-kms/package.json",
      "packages/hardhat-kms-gcp/package.json",
      "scripts/verify-release-tag.ts",
      "scripts/release-gate-ci.ts",
      "scripts/check-tarballs.ts",
      "scripts/security-checklist.ts",
      "scripts/temporary-install.ts",
      "scripts/consumer-typecheck.ts",
      "package.json",
      "pnpm-workspace.yaml",
      "docs/contributor/security-review.md",
      ".github/pull_request_template.md",
      "test/scripts/security-checklist.test.ts",
    ];
    assert.deepEqual(listedChanges(releasePaths, patterns), releasePaths.toSorted());
    assert.deepEqual(listedChanges(["packages/hardhat-kms/src/index.ts"], patterns), []);
  });

  it("lists every script that a listed script imports", () => {
    const patterns = lists.flatMap((list) => parseListedPaths(listPage, list.name));
    const scripts = patterns.filter(
      (pattern) => pattern.startsWith("scripts/") && !pattern.includes("*"),
    );
    const unlisted = scripts.flatMap((file) =>
      [...readFileSync(path.join(ROOT, file), "utf8").matchAll(/from "\.\/([^"]+\.ts)"/g)]
        .map((match) => `scripts/${match[1] ?? ""}`)
        .filter((imported) => listedChanges([imported], patterns).length === 0)
        .map((imported) => `${imported} (imported by ${file})`),
    );
    assert.deepEqual(unlisted, []);
  });

  it("has a template checklist whose every item is unticked", () => {
    const items = parseChecklist(readFileSync(path.join(ROOT, TEMPLATE), "utf8"));
    assert.ok(items !== undefined && items.length >= 11, "the template has both lists' items");
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
    assert.match(result.stdout, /Every item of the "Signing" checklist is ticked/);
  });

  it("exits 1 for a release-only change without the release items, and 0 with them", () => {
    const releaseFiles = [[{ filename: "packages/core/package.json" }]];
    const failed = run(releaseFiles, "1", body("x", "x"));
    assert.equal(failed.status, 1);
    assert.match(
      failed.stderr,
      /^FAIL This pull request changes 1 path\(s\) of the "Release" list/m,
    );
    assert.match(failed.stderr, /the item "Published\." is missing/);
    const passed = run(releaseFiles, "1", body(" ", " ", "x"));
    assert.equal(passed.status, 0, passed.stderr);
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
