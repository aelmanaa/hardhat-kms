// The user-page rule of `scripts/check-docs.ts`: the pages a user reads (docs/user and the READMEs,
// which npm shows) hold no milestone codes such as `M5` and no HTML comments, which GitHub hides but
// a raw view or a docs site can show. Code (fenced, indented and inline) is not prose, so it is
// blanked before both checks; URLs and link targets are blanked before the milestone check.
// Kept apart from check-docs.ts, which runs on import, so `test/scripts/user-pages.test.ts` can
// call it.

/** The marker that excludes the next snippet from the typecheck. */
export const SKIP_MARKER = "<!-- docs-check: skip -->";

/** The page whose pre-release note may stay: the release pull request reads and deletes it. */
export const PRE_RELEASE_PAGE = "docs/user/guides/install-before-release.md";

/**
 * Whether a user page may hold this HTML comment: the snippet skip marker anywhere, and the note at
 * the top of the pre-release install page that tells the release pull request what to delete.
 */
function isAllowedComment(file: string, comment: string): boolean {
  if (comment === SKIP_MARKER) {
    return true;
  }
  return file === PRE_RELEASE_PAGE && comment.startsWith("<!--\nPre-release only.");
}

/** Replaces each character but a newline with a space, so offsets and line numbers stay put. */
function blank(text: string): string {
  return text.replaceAll(/[^\n]/g, " ");
}

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

const LIST_ITEM = /^ {0,3}(?:[-*+]|\d+[.)])(?: |$)/;

/**
 * Blanks indented code blocks: lines indented by four spaces or a tab that follow a blank line,
 * when the paragraph before is not a list item or its continuation, where indentation nests
 * content instead.
 */
function blankIndentedCode(text: string): string {
  const lines = text.split("\n");
  let inCode = false;
  let inList = false;
  let previousBlank = true;
  for (const [index, line] of lines.entries()) {
    const isBlank = line.trim() === "";
    const indented = /^(?: {4}|\t)/.test(line);
    if (inCode && (indented || isBlank)) {
      lines[index] = blank(line);
    } else if (indented && previousBlank && !inList) {
      inCode = true;
      lines[index] = blank(line);
    } else if (!isBlank) {
      inCode = false;
      if (LIST_ITEM.test(line)) {
        inList = true;
      } else if (!/^\s/.test(line)) {
        inList = false;
      }
    }
    previousBlank = isBlank;
  }
  return lines.join("\n");
}

/** The text with fenced code, indented code and inline code spans blanked. */
function withoutCode(text: string): string {
  const unfenced = text.replaceAll(/^ {0,3}(`{3,}|~{3,})[\s\S]*?^ {0,3}\1[`~]*[ \t]*$/gm, blank);
  return blankIndentedCode(unfenced).replaceAll(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, blank);
}

/**
 * The problems of one user page, each as `file:line: message`.
 *
 * @param file - The page's path from the repository root, as reported.
 * @param text - The page's content.
 */
export function userPageProblems(file: string, text: string): string[] {
  const problems: string[] = [];
  const prose = withoutCode(text);
  for (const match of prose.matchAll(/<!--[\s\S]*?-->/g)) {
    if (!isAllowedComment(file, match[0])) {
      problems.push(
        `${file}:${lineOf(text, match.index)}: HTML comment in a user page; move maintainer notes to docs/contributor/`,
      );
    }
  }
  const words = prose
    .replaceAll(/<!--[\s\S]*?-->/g, blank)
    .replaceAll(/\]\([^)\n]*\)/g, blank)
    .replaceAll(/<?[a-z][a-z0-9+.-]*:\/\/[^\s<>)]+>?/gi, blank);
  for (const match of words.matchAll(/(?<![\w.-])M\d+(?![\w-])/g)) {
    if (/\b(?:Apple|chip|Max|Pro|Ultra)\b/.test(lineContext(words, match.index))) {
      continue;
    }
    problems.push(
      `${file}:${lineOf(text, match.index)}: milestone code ${match[0]} in a user page; say what works instead`,
    );
  }
  return problems;
}

/** The words around an offset, on its line, to tell a chip name such as "Apple M1" from a code. */
function lineContext(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", offset) + 1;
  const end = text.indexOf("\n", offset);
  const line = text.slice(start, end === -1 ? undefined : end);
  const column = offset - start;
  return line.slice(Math.max(0, column - 12), column + 16);
}
