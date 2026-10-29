// "Added in X.Y.Z." notes on the rows of the configuration and tasks references (#602). A row is a
// line of a table whose header's first cell is Field, Task or Option; it is known by its page, the
// heading above its table and its first cell. Authors write "Added in next." on a new row.
//
// Three modes:
// - `--stamp`, run by `pnpm run version-packages` after `changeset version`, replaces each
//   "Added in next." with the core's new version. A prerelease version (the next channel) leaves
//   the notes alone.
// - `--release`, run by release-stage.yml on a stable tag, fails when a note still says next.
// - With no mode, in the CI Docs job, it fails when a row that the tag of npm `latest` lacks carries
//   no note. It reads the pages at that tag with git, and fetches the tag when it is missing.
//
// Usage: node scripts/added-in.ts [--stamp | --release]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { SITE_PACKAGE, siteReleaseTag } from "./site-release-tag.ts";

/** The pages whose rows carry notes. */
export const REFERENCE_PAGES: readonly string[] = [
  "docs/user/reference/configuration.md",
  "docs/user/reference/tasks.md",
];

/** The first header cells of the tables whose rows carry notes. */
const NOTED_TABLES: ReadonlySet<string> = new Set(["Field", "Task", "Option"]);

/** A note: "Added in next." or "Added in X.Y.Z.". */
const NOTE = /\bAdded in (next|\d+\.\d+\.\d+)\./;

/** A row of a noted table. */
export interface ReferenceRow {
  /** The heading above the table, then the row's first cell. */
  key: string;
  /** The 1-based line number. */
  line: number;
  /** The version the row's note names, `next`, or undefined without a note. */
  added: string | undefined;
}

/** The cells of a table line, trimmed, with `\|` kept inside its cell. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replaceAll(/\s+/g, " "));
}

/**
 * A row's name: its first cell, with each code span cut before its first ` <`, ` [` or ` (`, so
 * that `kms sign <key> [--yes]` is `kms sign` and a new flag in a task's usage keeps the row's name.
 */
function rowName(cell: string): string {
  return cell.replaceAll(/`([^`]*)`/g, (_span, code: string) => `\`${code.split(/ [<[(]/)[0]}\``);
}

/**
 * The rows of the noted tables of a page.
 *
 * @param markdown - The page.
 * @returns Its rows, in order.
 */
export function referenceRows(markdown: string): ReferenceRow[] {
  const lines = markdown.split("\n");
  const rows: ReferenceRow[] = [];
  let heading = "";
  let fence = false;
  let noted = false;
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("```")) {
      fence = !fence;
      continue;
    }
    if (fence) {
      continue;
    }
    if (/^#{1,6} /.test(line)) {
      heading = line.replace(/^#+ /, "").trim();
      continue;
    }
    if (!line.startsWith("|")) {
      noted = false;
      continue;
    }
    const first = cells(line)[0] ?? "";
    const next = lines[index + 1] ?? "";
    if (/^\|[\s|:-]+\|$/.test(next.trim()) && !/^[\s|:-]+$/.test(line)) {
      // A header line: the delimiter row follows it.
      noted = NOTED_TABLES.has(first);
      continue;
    }
    if (!noted || /^[\s|:-]+$/.test(line)) {
      continue;
    }
    rows.push({
      key: `${heading} > ${rowName(first)}`,
      line: index + 1,
      added: NOTE.exec(line)?.[1],
    });
  }
  return rows;
}

/**
 * The rows of `current` that `released` lacks and that carry no note.
 *
 * @param page - The page's path, for the messages.
 * @param current - The page now.
 * @param released - The page at the tag of npm `latest`.
 * @returns One message per such row.
 */
export function missingNotes(page: string, current: string, released: string): string[] {
  const known = new Set(referenceRows(released).map((row) => row.key));
  return referenceRows(current)
    .filter((row) => !known.has(row.key) && row.added === undefined)
    .map(
      (row) =>
        `${page}:${row.line}: the row "${row.key}" is not in the release on npm latest; end its description with "Added in next."`,
    );
}

/**
 * The rows whose note still says next.
 *
 * @param page - The page's path, for the messages.
 * @param markdown - The page.
 * @returns One message per such row.
 */
export function nextNotes(page: string, markdown: string): string[] {
  return referenceRows(markdown)
    .filter((row) => row.added === "next")
    .map(
      (row) =>
        `${page}:${row.line}: the row "${row.key}" says "Added in next."; pnpm run version-packages replaces it with the version`,
    );
}

/**
 * The page with each "Added in next." replaced by the version.
 *
 * @param markdown - The page.
 * @param version - The core's new version.
 * @returns The page, unchanged for a prerelease version.
 */
export function stamp(markdown: string, version: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    return markdown;
  }
  return markdown.replaceAll("Added in next.", `Added in ${version}.`);
}

/** Reads a page at a tag, fetching the tag once when this clone lacks it. */
function pageAt(tag: string, page: string): string {
  const show = (): string =>
    execFileSync("git", ["show", `refs/tags/${tag}:${page}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    return show();
  } catch {
    execFileSync(
      "git",
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--depth=1",
        "origin",
        `+refs/tags/${tag}:refs/tags/${tag}`,
      ],
      { stdio: "inherit" },
    );
    return show();
  }
}

function main(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: { stamp: { type: "boolean" }, release: { type: "boolean" } },
  });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const read = (page: string): string => readFileSync(path.join(root, page), "utf8");
  if (values.stamp === true) {
    const manifest: unknown = JSON.parse(read("packages/hardhat-kms/package.json"));
    const version: unknown =
      typeof manifest === "object" && manifest !== null
        ? Reflect.get(manifest, "version")
        : undefined;
    if (typeof version !== "string") {
      throw new Error("packages/hardhat-kms/package.json has no version");
    }
    for (const page of REFERENCE_PAGES) {
      writeFileSync(path.join(root, page), stamp(read(page), version));
    }
    process.stdout.write(`"Added in next." notes now name ${version}, unless it is a prerelease\n`);
    return;
  }
  const problems =
    values.release === true
      ? REFERENCE_PAGES.flatMap((page) => nextNotes(page, read(page)))
      : (() => {
          const tag = siteReleaseTag(
            execFileSync("npm", ["view", SITE_PACKAGE, "dist-tags", "--json"], {
              encoding: "utf8",
            }),
          );
          return REFERENCE_PAGES.flatMap((page) =>
            missingNotes(page, read(page), pageAt(tag, page)),
          );
        })();
  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }
  process.stdout.write(
    values.release === true
      ? 'no reference row says "Added in next."\n'
      : 'every reference row that the release on npm latest lacks carries an "Added in" note\n',
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
