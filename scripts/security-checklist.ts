// The security checklist rule of pr-hygiene.yml. A pull request that changes a path listed in
// docs/contributor/security-review.md must carry the "Security checklist" section of the pull
// request template with every item ticked. A pull request that changes no listed path is not
// asked for it. The workflow runs this script, the list and the template from the base branch, so
// a pull request cannot change them for its own run.
//
// Usage: node scripts/security-checklist.ts --files FILE --changed-files N --body FILE
//   [--list FILE] [--template FILE] [--summary FILE]
//
// --files holds the output of `gh api --paginate --slurp repos/OWNER/REPO/pulls/N/files`.
// --changed-files is the pull request's `changed_files` count; a file list shorter than that (the
// API lists at most 3000 files) fails, because an unlisted file could be a listed path.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The page that holds the list of paths, relative to the repository root. */
export const LIST_PAGE = "docs/contributor/security-review.md";
/** The pull request template, relative to the repository root. */
export const TEMPLATE = ".github/pull_request_template.md";
/** The heading of the list on {@link LIST_PAGE}. */
export const LIST_HEADING = "## Listed paths";
/** The heading of the checklist in the template and in a pull request body. */
export const CHECKLIST_HEADING = "## Security checklist";

/**
 * Turns a path pattern into a regular expression over a repository-relative path. `**` matches
 * any number of directories, `*` any run of characters within one path segment; every other
 * character matches itself.
 *
 * @param pattern - The pattern, such as `packages/hardhat-kms/src/internal/rpc/**`.
 * @returns A regular expression anchored at both ends.
 */
export function patternToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern.charAt(index);
    if (char === "*" && pattern.charAt(index + 1) === "*") {
      const slashAfter = pattern.charAt(index + 2) === "/";
      source += slashAfter ? "(?:[^/]+/)*" : ".*";
      index += slashAfter ? 2 : 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`);
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Reads the patterns of the list page: the lines of the first fenced code block under
 * {@link LIST_HEADING}, without blank lines.
 *
 * @param markdown - The list page.
 * @returns The patterns, in page order.
 * @throws {Error} If the heading, the block or any pattern is missing.
 */
export function parseListedPaths(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const heading = lines.indexOf(LIST_HEADING);
  if (heading === -1) {
    throw new Error(`${LIST_PAGE} has no "${LIST_HEADING}" heading`);
  }
  const open = lines.findIndex((line, index) => index > heading && line.startsWith("```"));
  const nextHeading = lines.findIndex((line, index) => index > heading && line.startsWith("## "));
  if (open === -1 || (nextHeading !== -1 && open > nextHeading)) {
    throw new Error(`"${LIST_HEADING}" in ${LIST_PAGE} has no code block`);
  }
  const close = lines.findIndex((line, index) => index > open && line.startsWith("```"));
  if (close === -1) {
    throw new Error(`the code block under "${LIST_HEADING}" in ${LIST_PAGE} is not closed`);
  }
  const patterns = lines
    .slice(open + 1, close)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (patterns.length === 0) {
    throw new Error(`the code block under "${LIST_HEADING}" in ${LIST_PAGE} is empty`);
  }
  return patterns;
}

/**
 * Picks the changed paths that a pattern of the list matches.
 *
 * @param files - Repository-relative paths, with `/` separators.
 * @param patterns - The patterns of the list page.
 * @returns The matching paths, sorted, without duplicates.
 */
export function listedChanges(files: readonly string[], patterns: readonly string[]): string[] {
  const expressions = patterns.map((pattern) => patternToRegExp(pattern));
  const matched = files.filter((file) => expressions.some((expression) => expression.test(file)));
  return [...new Set(matched)].toSorted();
}

/** One entry of the pull request files API that this script reads. */
interface ChangedFile {
  filename: string;
  previous_filename?: string;
}

function isChangedFile(value: unknown): value is ChangedFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const filename: unknown = Reflect.get(value, "filename");
  const previous: unknown = Reflect.get(value, "previous_filename");
  return typeof filename === "string" && (previous === undefined || typeof previous === "string");
}

/**
 * Reads the changed paths from the output of `gh api --paginate --slurp` on the pull request
 * files endpoint: an array of pages, each an array of files. A renamed file counts under its old
 * and its new path, so moving a listed file out of a listed directory still needs the checklist.
 *
 * @param json - The command's output.
 * @param changedFiles - The pull request's `changed_files` count.
 * @returns The changed paths, old paths of renames included.
 * @throws {Error} If the output has another shape or lists fewer files than `changedFiles`.
 */
export function parseChangedFiles(json: string, changedFiles: number): string[] {
  const pages: unknown = JSON.parse(json);
  if (!Array.isArray(pages)) {
    throw new Error("the file list is not an array of pages");
  }
  const entries: ChangedFile[] = [];
  for (const page of pages) {
    if (!Array.isArray(page)) {
      throw new Error("a page of the file list is not an array");
    }
    for (const entry of page) {
      if (!isChangedFile(entry)) {
        throw new Error("an entry of the file list has no string filename");
      }
      entries.push(entry);
    }
  }
  if (entries.length < changedFiles) {
    throw new Error(
      `the file list names ${String(entries.length)} of the ${String(changedFiles)} changed files, so a listed path could be missing`,
    );
  }
  return entries.flatMap((entry) =>
    entry.previous_filename === undefined
      ? [entry.filename]
      : [entry.filename, entry.previous_filename],
  );
}

/** A checklist item: its label and whether its box is ticked. */
export interface ChecklistItem {
  label: string;
  ticked: boolean;
}

/**
 * Reads the items of the {@link CHECKLIST_HEADING} section, up to the next `##` heading. HTML
 * comments are ignored, so an example inside one does not count. An item is a task-list line
 * whose text starts with a bold label, `- [x] **Key.** ...`; its label is the bold text.
 *
 * @param markdown - A pull request body or the template.
 * @returns The items in order, or `undefined` if the section is missing.
 */
export function parseChecklist(markdown: string): ChecklistItem[] | undefined {
  const lines = markdown.replaceAll(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === CHECKLIST_HEADING);
  if (start === -1) {
    return undefined;
  }
  const items: ChecklistItem[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2} /.test(line)) {
      break;
    }
    const match = /^\s*[-*] \[([ xX])\] \*\*([^*]+)\*\*/.exec(line);
    if (match !== null) {
      items.push({ label: (match[2] ?? "").trim(), ticked: match[1] !== " " });
    }
  }
  return items;
}

/**
 * Lists what keeps a pull request body's checklist from being complete: a missing section, and
 * each required item that is missing or not ticked.
 *
 * @param body - The pull request body.
 * @param required - The labels the template's checklist holds.
 * @returns One line per problem; empty when the checklist is complete.
 */
export function checklistProblems(body: string, required: readonly string[]): string[] {
  const items = parseChecklist(body);
  if (items === undefined) {
    return [`the pull request body has no "${CHECKLIST_HEADING}" section`];
  }
  return required.flatMap((label) => {
    const item = items.find((candidate) => candidate.label === label);
    if (item === undefined) {
      return [`the item "${label}" is missing`];
    }
    return item.ticked ? [] : [`the item "${label}" is not ticked`];
  });
}

/** What the check found, and the lines it reports. */
export interface CheckResult {
  passed: boolean;
  lines: string[];
}

/**
 * Applies the rule: no listed path changed, or the checklist is complete.
 *
 * @param input - The changed paths, the list page, the template and the pull request body.
 * @returns Whether the pull request passes, and what to report.
 * @throws {Error} If the list page or the template cannot be read as expected.
 */
export function checkSecurityChecklist(input: {
  files: readonly string[];
  listPage: string;
  template: string;
  body: string;
}): CheckResult {
  const required = parseChecklist(input.template)?.map((item) => item.label) ?? [];
  if (required.length === 0) {
    throw new Error(`${TEMPLATE} has no items under "${CHECKLIST_HEADING}"`);
  }
  const changed = listedChanges(input.files, parseListedPaths(input.listPage));
  if (changed.length === 0) {
    return {
      passed: true,
      lines: [`No path listed in ${LIST_PAGE} changed. The security checklist is not required.`],
    };
  }
  const header = [
    `This pull request changes ${String(changed.length)} path(s) listed in ${LIST_PAGE}:`,
    ...changed.map((file) => `  ${file}`),
  ];
  const problems = checklistProblems(input.body, required);
  if (problems.length === 0) {
    return { passed: true, lines: [...header, "Every item of the security checklist is ticked."] };
  }
  return {
    passed: false,
    lines: [
      ...header,
      ...problems.map((problem) => `Security checklist: ${problem}.`),
      `Copy the "${CHECKLIST_HEADING}" section of ${TEMPLATE} into the description and tick each item once it holds.`,
    ],
  };
}

const usage =
  "usage: node scripts/security-checklist.ts --files FILE --changed-files N --body FILE [--list FILE] [--template FILE] [--summary FILE]";

function main(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      files: { type: "string" },
      "changed-files": { type: "string" },
      body: { type: "string" },
      list: { type: "string", default: path.join(root, LIST_PAGE) },
      template: { type: "string", default: path.join(root, TEMPLATE) },
      summary: { type: "string" },
    },
  });
  const count = values["changed-files"];
  if (
    positionals.length > 0 ||
    values.files === undefined ||
    values.body === undefined ||
    count === undefined
  ) {
    throw new Error(usage);
  }
  if (!/^\d+$/.test(count)) {
    throw new Error(`--changed-files must be a whole number, not ${count}`);
  }
  const result = checkSecurityChecklist({
    files: parseChangedFiles(readFileSync(values.files, "utf8"), Number(count)),
    listPage: readFileSync(values.list, "utf8"),
    template: readFileSync(values.template, "utf8"),
    body: readFileSync(values.body, "utf8"),
  });
  const text = `${result.lines.join("\n")}\n`;
  if (values.summary !== undefined) {
    appendFileSync(values.summary, `### Security checklist\n\n\`\`\`text\n${text}\`\`\`\n\n`);
  }
  if (result.passed) {
    process.stdout.write(text);
  } else {
    process.stderr.write(`FAIL ${text}`);
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`FAIL ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
