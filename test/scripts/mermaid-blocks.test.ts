// The Mermaid rule of `pnpm run docs:check` (`scripts/mermaid-blocks.ts`): every ```mermaid block
// parses with Mermaid's parser, in Node, with no browser.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mermaidProblems } from "../../scripts/mermaid-blocks.ts";

const FILE = "docs/contributor/example.md";
const check = async (code: string, line = 10): Promise<string[]> =>
  await mermaidProblems([{ file: FILE, line, code }]);

describe("mermaidProblems", () => {
  it("passes no blocks without loading Mermaid", async () => {
    assert.deepEqual(await mermaidProblems([]), []);
  });

  it("passes a flowchart with labels, subgraphs and edge text", async () => {
    const code = [
      "flowchart TD",
      '  subgraph chain["Credential chain"]',
      '    env["1. Environment<br/>AWS_ACCESS_KEY_ID"] -->|not set| ini["2. Profile"]',
      "  end",
      '  key["Key config"] --> profile{"profile set?"}',
      "  profile -->|yes| ini",
      "  profile -->|no| env",
    ].join("\n");
    assert.deepEqual(await check(code), []);
  });

  it("passes a sequence diagram", async () => {
    const code = "sequenceDiagram\n  participant C as Client\n  C->>H: eth_sendTransaction(tx)\n";
    assert.deepEqual(await check(code), []);
  });

  it("reports an unclosed label, at the block's opening fence", async () => {
    const problems = await check('flowchart TD\n  a["open label --> b\n', 20);
    assert.equal(problems.length, 1);
    assert.match(
      problems[0] ?? "",
      /^docs\/contributor\/example\.md:20: Mermaid block does not parse: Parse error/,
    );
  });

  it("reports an edge without a target", async () => {
    const problems = await check("flowchart TD\n  a --> b\n  b -->\n");
    assert.equal(problems.length, 1);
  });

  it("reports an unknown diagram type", async () => {
    const problems = await check("flowchartz TD\n  a --> b\n");
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? "", /^docs\/contributor\/example\.md:10: /);
  });

  it("reports a node id that is a Mermaid keyword", async () => {
    const problems = await check("flowchart TD\n  a --> call\n  call --> b\n");
    assert.equal(problems.length, 1);
  });

  it("reports a broken sequence message", async () => {
    const problems = await check("sequenceDiagram\n  A->>: \n");
    assert.equal(problems.length, 1);
  });

  it("reports each failing block, and only those", async () => {
    const problems = await mermaidProblems([
      { file: FILE, line: 1, code: "flowchart TD\n  a --> b\n" },
      { file: FILE, line: 9, code: "flowchart TD\n  a --> \n" },
      { file: "docs/user/other.md", line: 3, code: 'pie\n  title x\n  "a" : 1\n' },
      { file: "docs/user/other.md", line: 30, code: "flowchart TD\n  c[unclosed\n" },
    ]);
    assert.equal(problems.length, 2);
    assert.match(problems[0] ?? "", /^docs\/contributor\/example\.md:9: /);
    assert.match(problems[1] ?? "", /^docs\/user\/other\.md:30: /);
  });
});
