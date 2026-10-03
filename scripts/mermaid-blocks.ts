// The Mermaid rule of `scripts/check-docs.ts`: every ```mermaid block in the docs parses with
// Mermaid's own parser, so a diagram that GitHub would show as an error fails the check instead.
// Kept apart from check-docs.ts, which runs on import, so `test/scripts/mermaid-blocks.test.ts`
// can call it.
//
// `mermaid.parse()` runs in Node without a browser, with one exception: flowchart and state
// diagram labels pass through DOMPurify, which has no DOM to work on in Node, so its `addHook` and
// `sanitize` are missing. Parsing only needs the syntax, not the sanitised text, so both are
// replaced with no-ops on the copy of DOMPurify that Mermaid imports. The root package.json lists
// `dompurify` at the version Mermaid resolves, so this module and Mermaid share that one copy.
import DOMPurify from "dompurify";

/** A Mermaid block found in a Markdown file. */
export interface MermaidBlock {
  file: string;
  /** 1-based line of the opening fence. */
  line: number;
  code: string;
}

/** The part of the `mermaid` module this check uses. */
interface MermaidParser {
  parse(text: string): Promise<unknown>;
}

let parser: Promise<MermaidParser> | undefined;

/** Loads Mermaid once, after DOMPurify has the no-ops Mermaid calls during parsing. */
async function loadMermaid(): Promise<MermaidParser> {
  if (!DOMPurify.isSupported) {
    Object.assign(DOMPurify, { addHook: () => undefined, sanitize: (text: string) => text });
  }
  const { default: mermaid } = await import("mermaid");
  return mermaid;
}

/**
 * Parses each block with Mermaid and reports those that do not parse.
 *
 * @param blocks - The blocks to check.
 * @returns One problem per block that fails: the line of its opening fence and Mermaid's error
 * text on one line. The line in Mermaid's text is not the block's: Mermaid adds lines to a
 * flowchart before it parses it.
 */
export async function mermaidProblems(blocks: readonly MermaidBlock[]): Promise<string[]> {
  if (blocks.length === 0) {
    return [];
  }
  parser ??= loadMermaid();
  const mermaid = await parser;
  const problems: string[] = [];
  for (const block of blocks) {
    try {
      await mermaid.parse(block.code);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const text = message
        .split("\n")
        .map((part) => part.trim())
        .filter((part) => part !== "")
        .join(" ");
      problems.push(`${block.file}:${block.line}: Mermaid block does not parse: ${text}`);
    }
  }
  return problems;
}
