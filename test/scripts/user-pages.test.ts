// Two rules of `pnpm run docs:check` (`scripts/user-pages.ts`): a user page holds no milestone
// code and no HTML comment in prose, where code, URLs and chip names do not count; and no tracked
// file names a milestone, a review round or the maintainer's machine.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  internalWordProblems,
  PRE_RELEASE_PAGE,
  SKIP_MARKER,
  userPageProblems,
} from "../../scripts/user-pages.ts";

const PAGE = "docs/user/guides/example.md";
const check = (text: string, file = PAGE): string[] => userPageProblems(file, text);

describe("userPageProblems", () => {
  it("passes a page without milestone codes or comments", () => {
    assert.deepEqual(check("# Title\n\nAudience: users.\n\nThe plugin signs.\n"), []);
  });

  it("reports a milestone code in prose, with its line", () => {
    assert.deepEqual(check("# Title\n\nM5 adds signing.\n"), [
      `${PAGE}:3: milestone code M5 in a user page; say what works instead`,
    ]);
  });

  it("reports a milestone code in parentheses and in link text", () => {
    assert.equal(check("The adapter (M3) works.\n\n[M6](https://example.com/x)\n").length, 2);
  });

  it("ignores milestone-like words in inline code, fences and indented code", () => {
    const text = [
      "Use `M6` as a name, or ``a `M7` b``.",
      "",
      "```text",
      "M8",
      "```",
      "",
      "````md",
      "```",
      "M9",
      "```",
      "````",
      "",
      "Paragraph.",
      "",
      "    M11 in indented code",
      "",
    ].join("\n");
    assert.deepEqual(check(text), []);
  });

  it("checks a list item's indented continuation as prose", () => {
    assert.equal(check("- Item\n\n    M4 continues the item.\n").length, 1);
  });

  it("ignores codes inside URLs and link targets", () => {
    assert.deepEqual(
      check("See https://example.com/M9/page and [the page](https://example.com/a-M9).\n"),
      [],
    );
  });

  it("ignores Apple chip names", () => {
    assert.deepEqual(check("Tested on an Apple M1 chip and an M2 Max.\n"), []);
  });

  it("ignores codes inside words and identifiers", () => {
    assert.deepEqual(check("0xM5abc, SM3, M5x and AM5 are not milestones.\n"), []);
  });

  it("reports a maintainer comment, with its line", () => {
    assert.deepEqual(check("# Title\n\n<!-- maintainer: fix later -->\n"), [
      `${PAGE}:3: HTML comment in a user page; move maintainer notes to docs/contributor/`,
    ]);
  });

  it("does not report a comment inside a fence or inline code", () => {
    assert.deepEqual(check("Write `<!-- x -->` to hide text.\n\n```html\n<!-- y -->\n```\n"), []);
  });

  it("allows the skip marker anywhere", () => {
    assert.deepEqual(check(`${SKIP_MARKER}\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n`), []);
  });

  it("allows the pre-release note only on the pre-release page", () => {
    const note = "<!--\nPre-release only. The release PR deletes this page.\n-->\n";
    assert.deepEqual(check(note, PRE_RELEASE_PAGE), []);
    assert.equal(check(note).length, 1);
  });
});

describe("internalWordProblems", () => {
  const SOURCE = "packages/hardhat-kms/src/example.ts";
  const CONTRIBUTOR_PAGE = "docs/contributor/example.md";

  it("passes a file with none of the words", () => {
    const text = [
      "// The network hook adds the keys to the selected network's accounts.",
      'const userAgent = "Node/0.0.0 (Linux 0.0.0; x64)";',
      "const home = path.join(os.homedir(), 'project');",
      "",
    ].join("\n");
    assert.deepEqual(internalWordProblems(SOURCE, text), []);
    assert.deepEqual(
      internalWordProblems(CONTRIBUTOR_PAGE, "Status: every tool below is in place.\n"),
      [],
    );
  });

  it("reports a milestone code in a TypeScript comment, with its line", () => {
    const text = "/**\n * The network hook (planned for M7) adds them.\n */\nexport const x = 1;\n";
    assert.deepEqual(internalWordProblems(SOURCE, text), [
      `${SOURCE}:2: milestone code M7; say what exists instead`,
    ]);
  });

  it("reports a Darwin token inside a JSON string", () => {
    const file = "packages/hardhat-kms-aws/test/fixtures/events.json";
    const text =
      '{\n  "userAgent": "aws-sdk-js/3.0.0 os/darwin#0.0.0 Node/24.0.0 (Darwin 22.6.0; x64)"\n}\n';
    assert.deepEqual(internalWordProblems(file, text), [
      `${file}:2: "Darwin" names the recording machine's OS; zero the version and say Linux`,
    ]);
  });

  it("reports each review and decision phrase, in any case", () => {
    const cases: [string, string][] = [
      [
        "The owner decided on 2026-10-02: logs only.",
        '"owner decided" names who decided; state the decision',
      ],
      [
        "Review found that this rewrote answers.",
        '"Review found" names a review round; state the finding',
      ],
      [
        "Made while the pipeline was in review.",
        '"in review" names a review round; say what shipped',
      ],
      ["Tightened after review.", '"after review" names a review round; say what shipped'],
      [
        "The Fresh-Reader review (#75).",
        '"Fresh-Reader" names the review process; say what the page says',
      ],
    ];
    for (const [text, message] of cases) {
      assert.deepEqual(internalWordProblems(CONTRIBUTOR_PAGE, `${text}\n`), [
        `${CONTRIBUTOR_PAGE}:1: ${message}`,
      ]);
    }
  });

  it("reports each machine path", () => {
    const advice = "is a path on the maintainer's machine; use a relative or placeholder path";
    const cases: [string, string][] = [
      ["cd /Users/someone/project", "/Users/"],
      ["TMPDIR=/private/tmp/x node --test", "/private/tmp"],
      ["cache at /home/someone/.cache", "/home/"],
    ];
    for (const [text, word] of cases) {
      assert.deepEqual(internalWordProblems(SOURCE, `${text}\n`), [
        `${SOURCE}:1: "${word}" ${advice}`,
      ]);
    }
  });

  it("checks a Markdown file as prose: code, URLs and link targets do not count", () => {
    const text = [
      "Use `M6` as a name; see https://example.com/M9 and [the page](https://example.com/in-review).",
      "",
      "```sh",
      "ls /Users/someone",
      "```",
      "",
    ].join("\n");
    assert.deepEqual(internalWordProblems(CONTRIBUTOR_PAGE, text), []);
  });

  it("checks any other file whole, code included", () => {
    assert.equal(internalWordProblems(SOURCE, "const x = `M6 in a template`;\n").length, 1);
  });

  it("ignores Apple chip names", () => {
    assert.deepEqual(
      internalWordProblems(SOURCE, "// Tested on an Apple M1 chip and an M2 Max.\n"),
      [],
    );
  });

  it("reports every match, sorted by line", () => {
    const text = "in review\n\nowner decided\n\nM3 and Darwin\n";
    assert.deepEqual(
      internalWordProblems(CONTRIBUTOR_PAGE, text).map((problem) => problem.split(":")[1]),
      ["1", "3", "5", "5"],
    );
  });
});
