// "Added in" notes on the configuration and tasks references (`scripts/added-in.ts`, #602), on
// small pages. Runs in `pnpm test`, with no network and no git.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { missingNotes, nextNotes, referenceRows, stamp } from "../../scripts/added-in.ts";

const PAGE = `# Reference

| Field       | Meaning                          |
| ----------- | -------------------------------- |
| \`kms.keys\`  | Named keys.                      |
| \`newField\`  | New. Added in next.              |

| Provider | Key forms |
| -------- | --------- |
| \`aws\`    | \`keyId\`.  |

## \`kms sign\`

| Option             | What it does                  |
| ------------------ | ----------------------------- |
| \`--yes\`            | Skips. Added in 1.3.0.         |
| \`--chain <id>\`     | The chain.                     |

\`\`\`text
| Field | Meaning |
| ----- | ------- |
| \`inFence\` | Not a row. |
\`\`\`

## Tasks

| Task                               | Purpose |
| ---------------------------------- | ------- |
| \`kms sign <key> [--no-hash [--yes]]\` | Signs.  |
| \`kms verify (--address a \\| --key k)\` | Checks. |
`;

describe("referenceRows", () => {
  it("reads the rows of Field, Task and Option tables, named by heading and first cell", () => {
    assert.deepEqual(
      referenceRows(PAGE).map(({ key, added }) => [key, added]),
      [
        ["Reference > `kms.keys`", undefined],
        ["Reference > `newField`", "next"],
        ["`kms sign` > `--yes`", "1.3.0"],
        ["`kms sign` > `--chain`", undefined],
        ["Tasks > `kms sign`", undefined],
        ["Tasks > `kms verify`", undefined],
      ],
    );
  });

  it("gives each row its line number", () => {
    const lines = PAGE.split("\n");
    for (const row of referenceRows(PAGE)) {
      assert.equal(lines[row.line - 1]?.startsWith("|"), true, row.key);
    }
  });

  it("ignores a note that is not at a sentence's end, or names no version", () => {
    const page =
      "| Field | Meaning |\n| - | - |\n| `a` | Added in next |\n| `b` | Added in 1.3. |\n";
    assert.deepEqual(
      referenceRows(page).map((row) => row.added),
      [undefined, undefined],
    );
  });
});

describe("missingNotes", () => {
  const released = PAGE.replace("| `newField`  | New. Added in next.              |\n", "");

  it("passes rows the release has and new rows with a note", () => {
    assert.deepEqual(missingNotes("p.md", PAGE, released), []);
  });

  it("names a new row without a note, with its line", () => {
    const current = PAGE.replace(
      "| `--chain <id>`     | The chain.                     |",
      "$&\n| `--force` | Allows chain 0. |",
    );
    assert.deepEqual(missingNotes("p.md", current, released), [
      'p.md:18: the row "`kms sign` > `--force`" is not in the release on npm latest; end its description with "Added in next."',
    ]);
  });

  it("keeps a task's row when its usage gains a flag", () => {
    const current = PAGE.replace("[--no-hash [--yes]]", "[--no-hash [--yes]] [--json]");
    assert.deepEqual(missingNotes("p.md", current, released), []);
  });

  it("keeps a row under a renamed heading, and an option written with another placeholder", () => {
    const renamed = PAGE.replace("## `kms sign`", "## `kms sign-tx`").replace(
      "`--chain <id>`",
      "`--chain id`",
    );
    assert.deepEqual(missingNotes("p.md", renamed, released), []);
  });

  it("treats a renamed row as new unless it keeps the version that added it", () => {
    const renamed = PAGE.replace(
      "`--chain <id>`     | The chain.",
      "`--chain-id <id>`  | The chain.",
    );
    assert.equal(missingNotes("p.md", renamed, released).length, 1);
    const kept = renamed.replace("| The chain.", "| The chain. Added in 1.0.0.");
    assert.deepEqual(missingNotes("p.md", kept, released), []);
  });

  it("flags a row whose name is known elsewhere, in a new section or a new table under a kept heading", () => {
    const table =
      "\n| Option  | What it does |\n| ------- | ------------ |\n| `--yes` | Skips.       |\n";
    // A new section whose option shares a name with an existing one.
    const section = `${PAGE}\n## \`kms rotate\`\n${table}`;
    assert.deepEqual(
      missingNotes("p.md", section, released).map((problem) => problem.split('"')[1]),
      ["`kms rotate` > `--yes`"],
    );
    // A new Field table under a heading the release has, with a known field name.
    const field = PAGE.replace(
      "## Tasks\n",
      "## Tasks\n\n| Field      | Meaning |\n| ---------- | ------- |\n| `kms.keys` | Again.  |\n",
    );
    assert.deepEqual(
      missingNotes("p.md", field, released).map((problem) => problem.split('"')[1]),
      ["Tasks > `kms.keys`"],
    );
    // A renamed heading lends its rows' names only to rows under a heading the release lacks.
    const both = field
      .replace("## `kms sign`", "## `kms sign-tx`")
      .replace("`kms.keys` | Again.", "`--yes`    | Again.");
    assert.deepEqual(
      missingNotes("p.md", both, released).map((problem) => problem.split('"')[1]),
      ["Tasks > `--yes`"],
    );
  });
});

describe("nextNotes", () => {
  it("names each row that still says next", () => {
    assert.deepEqual(nextNotes("p.md", PAGE), [
      'p.md:6: the row "Reference > `newField`" says "Added in next."; pnpm run version-packages replaces it with the version',
    ]);
    assert.deepEqual(nextNotes("p.md", stamp(PAGE, "1.4.0")), []);
  });
});

describe("stamp", () => {
  it("replaces each next with the version", () => {
    assert.equal(
      stamp("A. Added in next. B. Added in next.", "1.4.0"),
      "A. Added in 1.4.0. B. Added in 1.4.0.",
    );
  });

  it("leaves the notes of a prerelease version", () => {
    assert.equal(stamp("Added in next.", "2.0.0-next.0"), "Added in next.");
  });
});
