// The snippet checks of `scripts/check-docs.ts`: every TypeScript snippet in the given Markdown files
// typechecks against the built packages, and calls no API marked `@deprecated`.
//
// Kept apart from check-docs.ts, which runs on import, so `test/scripts/doc-snippets.test.ts` can
// run the checks on fixture pages.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SKIP_MARKER } from "./user-pages.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TYPESCRIPT_LANGUAGES = new Set(["ts", "typescript", "tsx", "mts", "cts"]);

/** A fenced code block at the top level of a Markdown file. */
interface Fence {
  language: string;
  /** 1-based line of the opening fence. */
  line: number;
  code: string;
  skipped: boolean;
}

/**
 * Parses the top-level fenced code blocks of a Markdown file (CommonMark fences: three or more
 * backticks or tildes, indented by at most three spaces). Fences inside another fence, such as a
 * Markdown example that shows a TypeScript block, are part of the outer block's content.
 */
function fences(file: string): Fence[] {
  const lines = readFileSync(path.join(root, file), "utf8").split(/\r?\n/);
  const found: Fence[] = [];
  for (let index = 0; index < lines.length; index++) {
    const open = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(lines[index] ?? "");
    if (open === null) {
      continue;
    }
    const [, marker = "```", language = ""] = open;
    const closing = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
    const end = lines.findIndex((line, at) => at > index && closing.test(line));
    if (end === -1) {
      throw new Error(`${file}:${index + 1}: unterminated code block`);
    }
    const previous = lines.slice(0, index).findLast((line) => line.trim() !== "");
    found.push({
      language: language.toLowerCase(),
      line: index + 1,
      code: lines.slice(index + 1, end).join("\n"),
      skipped: previous?.trim() === SKIP_MARKER,
    });
    index = end;
  }
  return found;
}

/** Compiler options for snippets: strict, as many users' projects are. */
const SNIPPET_COMPILER_OPTIONS = {
  target: "ES2023",
  module: "nodenext",
  moduleResolution: "nodenext",
  strict: true,
  exactOptionalPropertyTypes: true,
  noEmit: true,
  skipLibCheck: true,
  types: ["node"],
};

/** Turns `file:line` of an opening fence and a 1-based snippet line into the Markdown file's line. */
function markdownLine(source: string, snippetLine: number): string {
  const [file = source, start = "0"] = source.split(":");
  // Line 1 of the snippet is the line after the opening fence.
  return `${file}:${Number(start) + snippetLine}`;
}

/**
 * Typechecks one snippet as its own program, so type extensions declared in one snippet cannot
 * make another pass. The snippet sits inside the package, so `hardhat-kms` resolves through the
 * package's own `exports` to the built types, as it does for users.
 */
function checkSnippet(directory: string, source: string, code: string): string[] {
  mkdirSync(directory, { recursive: true });
  // `export {}` makes the snippet a module even when it has no imports.
  writeFileSync(path.join(directory, "snippet.ts"), `${code}\nexport {};\n`);
  writeFileSync(
    path.join(directory, "tsconfig.json"),
    JSON.stringify({ compilerOptions: SNIPPET_COMPILER_OPTIONS, include: ["snippet.ts"] }),
  );
  const result = spawnSync(
    process.execPath,
    [path.join(root, "node_modules/typescript/bin/tsc"), "-p", directory, "--pretty", "false"],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status === 0) {
    return [];
  }
  const errors: string[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /snippet\.ts\((\d+),\d+\): (error TS\d+: .*)$/.exec(line);
    if (match !== null) {
      errors.push(`${markdownLine(source, Number(match[1]))}: ${match[2] ?? ""}`);
    } else if (/^\s+\S/.test(line) && errors.length > 0) {
      errors.push(line); // tsc's follow-up explanation of the previous error.
    }
  }
  // A crash, a missing compiler or an error outside the snippet: report tsc's own output.
  return errors.length > 0
    ? errors
    : [
        `${source}: tsc failed (exit ${String(result.status)}): ${`${result.stdout}${result.stderr}`.trim()}`,
      ];
}

/** A relative path with forward slashes, as oxlint prints it on every OS. */
function toPosix(file: string): string {
  return file.split(path.sep).join("/");
}

/** Reads a field of a parsed JSON value. */
function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

/**
 * Runs oxlint with type information and only `typescript/no-deprecated` on the written snippets,
 * in one process: each snippet keeps its own `tsconfig.json`, so it is checked in its own program,
 * as `tsc` checked it. `snippets` maps each `snippet.ts`, relative to the root, to the `file:line`
 * of its opening fence.
 *
 * The config is written next to the snippets, so the repository's `.oxlintrc.json`, with its other
 * rules, is not loaded. `--no-ignore` because `.gitignore` lists the snippet directory.
 */
function lintDeprecated(directory: string, snippets: Map<string, string>): string[] {
  if (snippets.size === 0) {
    return [];
  }
  const config = path.join(directory, "oxlint.json");
  writeFileSync(config, JSON.stringify({ plugins: ["typescript"], options: { typeAware: true } }));
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules/oxlint/bin/oxlint"),
      "--config",
      config,
      "--allow",
      "all",
      "--deny",
      "typescript/no-deprecated",
      "--no-ignore",
      "--format",
      "json",
      ...snippets.keys(),
    ],
    { cwd: root, encoding: "utf8" },
  );
  let report: unknown;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    report = undefined;
  }
  const diagnostics = field(report, "diagnostics");
  if (!Array.isArray(diagnostics) || field(report, "number_of_files") !== snippets.size) {
    return [
      `oxlint failed (exit ${String(result.status)}): ${`${result.stdout}${result.stderr}`.trim()}`,
    ];
  }
  const problems: string[] = [];
  for (const diagnostic of diagnostics) {
    const filename = field(diagnostic, "filename");
    const source = typeof filename === "string" ? snippets.get(toPosix(filename)) : undefined;
    const labels = field(diagnostic, "labels");
    const line = field(field(Array.isArray(labels) ? labels[0] : undefined, "span"), "line");
    const code = field(diagnostic, "code");
    const message = field(diagnostic, "message");
    if (source === undefined || typeof line !== "number") {
      problems.push(
        `oxlint reported a problem outside the snippets: ${JSON.stringify(diagnostic)}`,
      );
      continue;
    }
    // The message is the API's `@deprecated` text, which can span lines.
    const text = String(message).replaceAll(/\s+/g, " ").trim();
    problems.push(`${markdownLine(source, line)}: ${String(code)}: ${text}`);
  }
  // A failing exit without diagnostics means oxlint itself failed.
  if (problems.length === 0 && result.status !== 0) {
    problems.push(`oxlint failed (exit ${String(result.status)}): ${result.stderr.trim()}`);
  }
  return problems;
}

/**
 * Checks every TypeScript snippet of `files` (paths relative to the root) that is not preceded by
 * the skip marker: it typechecks, and calls no API marked `@deprecated`. Each snippet is written
 * to its own directory under `directory`, which must be inside the root, so the snippets resolve
 * the root's dependencies; the directory is removed before and after.
 */
export function checkSnippets(
  files: string[],
  directory: string = path.join(root, ".docs-check"),
): string[] {
  rmSync(directory, { recursive: true, force: true });
  try {
    const problems: string[] = [];
    const snippets = new Map<string, string>();
    for (const file of files) {
      for (const fence of fences(file)) {
        if (!TYPESCRIPT_LANGUAGES.has(fence.language) || fence.skipped) {
          continue;
        }
        const snippetDirectory = path.join(directory, `snippet-${snippets.size + 1}`);
        const source = `${file}:${fence.line}`;
        problems.push(...checkSnippet(snippetDirectory, source, fence.code));
        snippets.set(
          toPosix(path.relative(root, path.join(snippetDirectory, "snippet.ts"))),
          source,
        );
      }
    }
    return [...problems, ...lintDeprecated(directory, snippets)];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
