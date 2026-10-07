// The frontmatter rule of `pnpm run docs:check` (`scripts/frontmatter.ts`): every user page has a
// `title` equal to its H1 and a description of its own, within the length limits.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parse } from "yaml";

import {
  DESCRIPTION_MAX,
  DESCRIPTION_MIN,
  firstHeading,
  frontmatterProblems,
  renderFrontmatter,
  TITLE_MAX,
} from "../../scripts/frontmatter.ts";

const FILE = "docs/user/guides/example.md";
const DESCRIPTION = "Sign Hardhat transactions with a key in a cloud KMS, from config to deploy.";

function page(fields: Record<string, string>, h1 = "Example guide"): string {
  const yaml = Object.entries(fields)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
  return `---\n${yaml}\n---\n\n# ${h1}\n\nAudience: users.\n`;
}

const check = (text: string, file = FILE): string[] => frontmatterProblems([{ file, text }]);

describe("frontmatterProblems", () => {
  it("passes a page with a title equal to its H1 and a description", () => {
    assert.deepEqual(check(page({ title: "Example guide", description: DESCRIPTION })), []);
  });

  it("reports a page without frontmatter", () => {
    assert.deepEqual(check("# Example guide\n\nText.\n"), [
      `${FILE}:1: no frontmatter; start the page with a --- block that holds title and description`,
    ]);
  });

  it("reports frontmatter that is not valid YAML", () => {
    const problems = check("---\ntitle: a: b\n---\n\n# a: b\n");
    assert.equal(problems.length, 1);
    assert.match(
      problems[0] ?? "",
      /^docs\/user\/guides\/example\.md:1: frontmatter is not valid YAML/,
    );
  });

  it("reports a missing description", () => {
    assert.deepEqual(check(page({ title: "Example guide" })), [
      `${FILE}:1: frontmatter has no description; write one sentence for the question the page answers`,
    ]);
  });

  it("reports an empty description", () => {
    assert.equal(check(page({ title: "Example guide", description: "  " })).length, 1);
  });

  it("reports a missing title", () => {
    assert.deepEqual(check(page({ description: DESCRIPTION })), [
      `${FILE}:1: frontmatter has no title; set it to the page's H1`,
    ]);
  });

  it("reports a title that differs from the H1", () => {
    assert.deepEqual(check(page({ title: "Another title", description: DESCRIPTION })), [
      `${FILE}:1: title "Another title" differs from the H1 "Example guide"`,
    ]);
  });

  it("reports a page with no H1", () => {
    const text = `---\ntitle: Example\ndescription: ${DESCRIPTION}\n---\n\nText only.\n`;
    assert.deepEqual(check(text), [
      `${FILE}: no H1 after the frontmatter; the title must equal it`,
    ]);
  });

  it("ignores an H1 inside a fence before the real one", () => {
    const text = `---\ntitle: Real\ndescription: ${DESCRIPTION}\n---\n\n\`\`\`md\n# Fake\n\`\`\`\n\n# Real\n`;
    assert.deepEqual(check(text), []);
  });

  it("reports a title over the limit", () => {
    const title = "T".repeat(TITLE_MAX + 1);
    assert.deepEqual(check(page({ title, description: DESCRIPTION }, title)), [
      `${FILE}:1: title is ${String(TITLE_MAX + 1)} characters; keep it to ${String(TITLE_MAX)}`,
    ]);
  });

  it("accepts descriptions at both limits", () => {
    for (const length of [DESCRIPTION_MIN, DESCRIPTION_MAX]) {
      const description = "d".repeat(length);
      assert.deepEqual(check(page({ title: "Example guide", description })), [], String(length));
    }
  });

  it("reports descriptions out of range", () => {
    for (const length of [DESCRIPTION_MIN - 1, DESCRIPTION_MAX + 1]) {
      assert.deepEqual(check(page({ title: "Example guide", description: "d".repeat(length) })), [
        `${FILE}:1: description is ${String(length)} characters; keep it between ${String(DESCRIPTION_MIN)} and ${String(DESCRIPTION_MAX)}`,
      ]);
    }
  });

  it("reports a description on several lines", () => {
    const description = `${DESCRIPTION}\nA second line.`;
    assert.deepEqual(check(page({ title: "Example guide", description })), [
      `${FILE}:1: description spans several lines; write one sentence on one line`,
    ]);
  });

  it("reports a description that another page has, naming the first page", () => {
    const text = page({ title: "Example guide", description: DESCRIPTION });
    const other = "docs/user/guides/other.md";
    assert.deepEqual(
      frontmatterProblems([
        { file: FILE, text },
        { file: other, text },
      ]),
      [`${other}:1: description is the same as ${FILE}'s; each page needs its own`],
    );
  });
});

describe("renderFrontmatter", () => {
  it("renders YAML that parses back, quoting a value with a colon", () => {
    const fields = { title: "Tasks reference", description: `kms history: ${DESCRIPTION}` };
    const block = renderFrontmatter(fields);
    assert.match(block, /^---\n[\s\S]*\n---\n\n$/);
    assert.deepEqual(parse(block.slice(4, -6)), fields);
    assert.deepEqual(check(`${block}# Tasks reference\n`), []);
  });

  it("keeps a long description on one line", () => {
    const description = "word ".repeat(40).trim();
    assert.equal(renderFrontmatter({ title: "T", description }).split("\n").length, 6);
  });
});

describe("firstHeading", () => {
  it("returns the first H1, without a closing sequence", () => {
    assert.equal(firstHeading("Intro\n\n## Two\n\n# One #\n\n# Later\n"), "One");
  });

  it("returns undefined without an H1", () => {
    assert.equal(firstHeading("## Two\n"), undefined);
  });
});
