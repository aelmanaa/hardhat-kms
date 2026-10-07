// The skill rules of `pnpm run docs:check` (`scripts/skills.ts`): a skill's frontmatter names its
// directory and carries a description within the limit, and its links into the repository's
// `main` branch point at files that exist.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  REPOSITORY_BLOB,
  repositoryLinkProblems,
  SKILL_DESCRIPTION_MAX,
  skillProblems,
} from "../../scripts/skills.ts";

const FILE = "skills/example-skill/SKILL.md";
const skill = (frontmatter: string): string => `---\n${frontmatter}\n---\n\n# Example\n`;

describe("skillProblems", () => {
  it("passes a skill whose name is its directory and which has a description", () => {
    assert.deepEqual(
      skillProblems(FILE, skill("name: example-skill\ndescription: Does one thing.\nlicense: MIT")),
      [],
    );
  });

  it("reports a skill without frontmatter", () => {
    assert.deepEqual(skillProblems(FILE, "# Example\n"), [
      `${FILE}:1: no frontmatter; a skill starts with a --- block that holds name and description`,
    ]);
  });

  it("reports frontmatter that is not valid YAML", () => {
    assert.match(
      skillProblems(FILE, skill("name: a: b"))[0] ?? "",
      /frontmatter is not valid YAML/,
    );
  });

  it("reports a missing name and a missing description", () => {
    assert.deepEqual(skillProblems(FILE, skill("license: MIT")), [
      `${FILE}:1: frontmatter has no name; set it to the directory's name, example-skill`,
      `${FILE}:1: frontmatter has no description; say what the skill does and when to use it`,
    ]);
  });

  it("reports a name that differs from the directory", () => {
    assert.deepEqual(skillProblems(FILE, skill("name: other\ndescription: Does one thing.")), [
      `${FILE}:1: name "other" differs from the directory's name, example-skill`,
    ]);
  });

  it("reports a name with capitals or double hyphens", () => {
    for (const name of ["Example", "a--b"]) {
      const file = `skills/${name}/SKILL.md`;
      assert.equal(skillProblems(file, skill(`name: ${name}\ndescription: x`)).length, 1, name);
    }
  });

  it("accepts a description at the limit and reports one over it", () => {
    const at = "d".repeat(SKILL_DESCRIPTION_MAX);
    assert.deepEqual(skillProblems(FILE, skill(`name: example-skill\ndescription: ${at}`)), []);
    assert.deepEqual(skillProblems(FILE, skill(`name: example-skill\ndescription: ${at}d`)), [
      `${FILE}:1: description is ${String(SKILL_DESCRIPTION_MAX + 1)} characters; keep it to ${String(SKILL_DESCRIPTION_MAX)}`,
    ]);
  });
});

describe("repositoryLinkProblems", () => {
  const existing = new Set(["docs/user/reference/tasks.md", "examples/README.md"]);
  const exists = (target: string): boolean => existing.has(target);

  it("passes links to existing files, with or without an anchor", () => {
    const text = `[a](${REPOSITORY_BLOB}docs/user/reference/tasks.md#kms-accounts) and <${REPOSITORY_BLOB}examples/README.md>\n`;
    assert.deepEqual(repositoryLinkProblems(FILE, text, exists), []);
  });

  it("reports a link to a missing file, with its line", () => {
    const text = `Intro.\n\n[b](${REPOSITORY_BLOB}docs/user/guides/gone.md)\n`;
    assert.deepEqual(repositoryLinkProblems(FILE, text, exists), [
      `${FILE}:3: links to docs/user/guides/gone.md, which does not exist on this branch`,
    ]);
  });

  it("ignores links to other repositories and other branches", () => {
    const text =
      "[c](https://github.com/other/repo/blob/main/x.md) [d](https://github.com/aelmanaa/hardhat-kms/blob/v1/x.md)\n";
    assert.deepEqual(repositoryLinkProblems(FILE, text, exists), []);
  });
});
