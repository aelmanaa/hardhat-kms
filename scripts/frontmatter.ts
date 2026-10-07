// The frontmatter rule of `scripts/check-docs.ts`: every page under docs/user/ starts with YAML
// frontmatter that holds a `title` and a `description`, which the docs site uses for the HTML
// title, the meta description and the search index.
// - `title` equals the page's H1 and is at most TITLE_MAX characters;
// - `description` is one line of DESCRIPTION_MIN to DESCRIPTION_MAX characters;
// - no two pages share a description.
// The API reference generator (scripts/generate-api-docs.ts) writes its pages' frontmatter with
// renderFrontmatter, so the generated pages follow the same rule.
// Kept apart from check-docs.ts, which runs on import, so `test/scripts/frontmatter.test.ts` can
// call it.
import { parse, stringify } from "yaml";

/** The longest title, in characters: search results cut longer ones. */
export const TITLE_MAX = 60;

/** The shortest description, in characters: shorter ones say too little to pick a page by. */
export const DESCRIPTION_MIN = 40;

/** The longest description, in characters: search results cut longer ones. */
export const DESCRIPTION_MAX = 160;

/** A page's frontmatter fields. */
export interface PageFrontmatter {
  readonly title: string;
  readonly description: string;
}

/** A page to check: its path from the repository root, as reported, and its content. */
export interface Page {
  readonly file: string;
  readonly text: string;
}

const BLOCK = /^---\n([\s\S]*?)\n---(?:\n|$)/;

/**
 * Renders a frontmatter block, followed by a blank line, to put before a page's H1.
 *
 * @param fields - The page's title and description.
 * @returns The block, from the opening `---` to the blank line after the closing one.
 */
export function renderFrontmatter(fields: PageFrontmatter): string {
  const yaml = stringify(
    { title: fields.title, description: fields.description },
    { lineWidth: 0 },
  );
  return `---\n${yaml}---\n\n`;
}

/** The text of a page's first H1 outside fenced code, or undefined. */
export function firstHeading(body: string): string | undefined {
  let fence: string | undefined;
  for (const line of body.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) {
        fence = marker;
      } else if (line.trimStart().startsWith(fence)) {
        fence = undefined;
      }
      continue;
    }
    const heading = fence === undefined ? /^ {0,3}# +(.+?)(?: +#+)? *$/.exec(line) : null;
    if (heading?.[1] !== undefined) {
      return heading[1];
    }
  }
  return undefined;
}

function property(data: unknown, name: string): unknown {
  return typeof data === "object" && data !== null ? Reflect.get(data, name) : undefined;
}

/** The problems of one page's frontmatter, and its description when it has a usable one. */
function pageProblems(page: Page): { problems: string[]; description?: string } {
  const { file, text } = page;
  const block = BLOCK.exec(text);
  if (block === null) {
    return {
      problems: [
        `${file}:1: no frontmatter; start the page with a --- block that holds title and description`,
      ],
    };
  }
  let data: unknown;
  try {
    data = parse(block[1] ?? "");
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { problems: [`${file}:1: frontmatter is not valid YAML (${reason})`] };
  }
  const problems: string[] = [];
  const heading = firstHeading(text.slice(block[0].length));
  const title = property(data, "title");
  if (typeof title !== "string" || title.trim() === "") {
    problems.push(`${file}:1: frontmatter has no title; set it to the page's H1`);
  } else {
    if (title.length > TITLE_MAX) {
      problems.push(
        `${file}:1: title is ${String(title.length)} characters; keep it to ${String(TITLE_MAX)}`,
      );
    }
    if (heading === undefined) {
      problems.push(`${file}: no H1 after the frontmatter; the title must equal it`);
    } else if (heading !== title) {
      problems.push(`${file}:1: title "${title}" differs from the H1 "${heading}"`);
    }
  }
  const description = property(data, "description");
  if (typeof description !== "string" || description.trim() === "") {
    problems.push(
      `${file}:1: frontmatter has no description; write one sentence for the question the page answers`,
    );
    return { problems };
  }
  if (description.includes("\n")) {
    problems.push(`${file}:1: description spans several lines; write one sentence on one line`);
  }
  if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
    problems.push(
      `${file}:1: description is ${String(description.length)} characters; keep it between ${String(DESCRIPTION_MIN)} and ${String(DESCRIPTION_MAX)}`,
    );
  }
  return { problems, description };
}

/**
 * The frontmatter problems of a set of pages, each as `file[:line]: message`.
 *
 * @param pages - The pages under docs/user/.
 */
export function frontmatterProblems(pages: readonly Page[]): string[] {
  const problems: string[] = [];
  const byDescription = new Map<string, string>();
  for (const page of pages) {
    const result = pageProblems(page);
    problems.push(...result.problems);
    if (result.description === undefined) {
      continue;
    }
    const first = byDescription.get(result.description);
    if (first === undefined) {
      byDescription.set(result.description, page.file);
    } else {
      problems.push(
        `${page.file}:1: description is the same as ${first}'s; each page needs its own`,
      );
    }
  }
  return problems;
}
