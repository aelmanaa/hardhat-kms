// Keeps the docs in step with the code:
// - every TypeScript snippet in the READMEs and docs/ typechecks against the built package, the way
//   a user's project imports it (run `pnpm run build` first; `pnpm run docs:check` does);
// - every page under docs/ is linked from AGENTS.md and docs/README.md, and every decision record
//   from the decision index, with the exceptions listed in checkIndexes;
// - docs/user/reference/errors.md matches the error catalogues (scripts/generate-errors-doc.ts);
// - first-party source builds its errors only through the catalogue helpers (checkErrorSites).
// lychee checks the links themselves (see lychee.toml).
//
// A snippet that is not meant to compile, such as a sketch of a planned API, is preceded by
// `<!-- docs-check: skip -->` on its own line.
//
// Usage: node scripts/check-docs.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ERRORS_DOC,
  ERRORS_DOC_COMMAND,
  loadCatalogues,
  renderErrorsDoc,
} from "./generate-errors-doc.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_MARKER = "<!-- docs-check: skip -->";
const TYPESCRIPT_LANGUAGES = new Set(["ts", "typescript", "tsx", "mts", "cts"]);

function markdownFiles(directory: string): string[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      return markdownFiles(relative);
    }
    return entry.name.endsWith(".md") ? [relative] : [];
  });
}

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
  const [file = source, start = "0"] = source.split(":");
  const errors: string[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /snippet\.ts\((\d+),\d+\): (error TS\d+: .*)$/.exec(line);
    if (match !== null) {
      // Line 1 of the snippet is the line after the opening fence.
      errors.push(`${file}:${Number(start) + Number(match[1])}: ${match[2] ?? ""}`);
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

function checkSnippets(files: string[]): string[] {
  const directory = path.join(root, ".docs-check");
  rmSync(directory, { recursive: true, force: true });
  try {
    const problems: string[] = [];
    let count = 0;
    for (const file of files) {
      for (const fence of fences(file)) {
        if (!TYPESCRIPT_LANGUAGES.has(fence.language) || fence.skipped) {
          continue;
        }
        count++;
        problems.push(
          ...checkSnippet(
            path.join(directory, `snippet-${count}`),
            `${file}:${fence.line}`,
            fence.code,
          ),
        );
      }
    }
    return problems;
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Collects the link targets of a Markdown file, without anchors: inline links `[text](target)`,
 * with or without a title, and reference definitions `[label]: target`. Code blocks, inline code
 * and HTML comments are ignored, so a path mentioned there does not count as a link.
 */
function linkTargets(file: string): Set<string> {
  const text = readFileSync(path.join(root, file), "utf8")
    .replaceAll(/<!--[\s\S]*?-->/g, "")
    .replaceAll(/^ {0,3}(`{3,}|~{3,})[\s\S]*?^ {0,3}\1\s*$/gm, "")
    .replaceAll(/`[^`\n]*`/g, "");
  const targets = new Set<string>();
  const add = (target: string): void => {
    const withoutAnchor = target.split("#")[0] ?? "";
    targets.add(path.posix.normalize(path.posix.join(path.posix.dirname(file), withoutAnchor)));
  };
  for (const match of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    add(match[1] ?? "");
  }
  for (const match of text.matchAll(/^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/gm)) {
    add(match[1] ?? "");
  }
  return targets;
}

function checkIndexes(pages: string[]): string[] {
  const agents = linkTargets("AGENTS.md");
  const docsIndex = linkTargets("docs/README.md");
  const decisionsIndex = linkTargets("docs/contributor/decisions/README.md");
  const problems: string[] = [];
  for (const page of pages) {
    if (page === "docs/README.md" || page === "docs/contributor/decisions/template.md") {
      continue;
    }
    if (!agents.has(page)) {
      problems.push(`AGENTS.md does not link ${page}`);
    }
    const isDecision = /^docs\/contributor\/decisions\/\d{4}-/.test(page);
    if (isDecision && !decisionsIndex.has(page)) {
      problems.push(`docs/contributor/decisions/README.md does not link ${page}`);
    }
    // Decision records are listed in their own index; DESIGN.md only redirects to other pages.
    if (!isDecision && page !== "docs/DESIGN.md" && !docsIndex.has(page)) {
      problems.push(`docs/README.md does not link ${page}`);
    }
  }
  return problems;
}

/** The README of each workspace package, which npm shows on the package page. */
function packageReadmes(): string[] {
  return readdirSync(path.join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.posix.join("packages", entry.name, "README.md"))
    .filter((file) => existsSync(path.join(root, file)));
}

/** Fails when the errors page differs from what the catalogues generate. */
async function checkErrorsDoc(): Promise<string[]> {
  const expected = renderErrorsDoc(await loadCatalogues());
  const file = path.join(root, ERRORS_DOC);
  const actual = existsSync(file) ? readFileSync(file, "utf8") : "";
  return actual === expected
    ? []
    : [`${ERRORS_DOC} is out of date with the error catalogues. Run \`${ERRORS_DOC_COMMAND}\`.`];
}

/**
 * Packages whose errors are not in a catalogue yet; their source is not checked. The provider
 * packages get their catalogues in a follow-up to #72.
 */
const UNCATALOGUED_PACKAGES = new Set(["hardhat-kms-aws", "hardhat-kms-azure", "hardhat-kms-gcp"]);

/** The one file that may build errors without a catalogue entry: the helpers themselves. */
const ERROR_HELPERS = "packages/hardhat-kms/src/internal/errors.ts";

function sourceFiles(directory: string): string[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "vendor" ? [] : sourceFiles(relative);
    }
    return entry.name.endsWith(".ts") ? [relative] : [];
  });
}

/**
 * Blanks the comments of a TypeScript file and keeps everything else, so offsets and line numbers
 * stay. A `/` that starts a regular expression is read as code, which is enough for this source.
 */
function withoutComments(source: string): string {
  let result = "";
  let quote: string | undefined;
  for (let index = 0; index < source.length; index++) {
    const char = source[index] ?? "";
    if (quote !== undefined) {
      result += char;
      if (char === "\\") {
        result += source[index + 1] ?? "";
        index++;
      } else if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
      result += char;
    } else if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      result += " ".repeat(stop - index);
      index = stop - 1;
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      result += source.slice(index, stop).replaceAll(/[^\n]/g, " ");
      index = stop - 1;
    } else {
      result += char;
    }
  }
  return result;
}

/** The text between the parenthesis at `open` and its match, strings and nesting included. */
function argumentsAt(code: string, open: number): string {
  let depth = 0;
  let quote: string | undefined;
  for (let index = open; index < code.length; index++) {
    const char = code[index];
    if (quote !== undefined) {
      if (char === "\\") {
        index++;
      } else if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
      if (depth === 0) {
        return code.slice(open + 1, index);
      }
    }
  }
  return code.slice(open + 1);
}

/**
 * Fails on first-party code that builds an error without the catalogue helpers of
 * packages/hardhat-kms/src/internal/errors.ts: a call to `kmsError`, a `new HardhatPluginError`,
 * an error object (`new …Error(` or `new …Failure(`) whose arguments do not call
 * `catalogMessage`, and a thrown string.
 */
function checkErrorSites(): string[] {
  const problems: string[] = [];
  const packages = readdirSync(path.join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !UNCATALOGUED_PACKAGES.has(entry.name))
    .map((entry) => path.posix.join("packages", entry.name, "src"))
    .filter((directory) => existsSync(path.join(root, directory)));
  for (const file of packages.flatMap((directory) => sourceFiles(directory))) {
    if (file === ERROR_HELPERS) {
      continue;
    }
    const code = withoutComments(readFileSync(path.join(root, file), "utf8"));
    const lineOf = (offset: number): number => code.slice(0, offset).split("\n").length;
    const report = (offset: number, what: string): void => {
      problems.push(
        `${file}:${lineOf(offset)}: ${what}; build it from a catalogue entry with catalogError, catalogMessage or internalError`,
      );
    };
    for (const match of code.matchAll(/\bkmsError\s*\(/g)) {
      report(match.index, "kmsError() call");
    }
    for (const match of code.matchAll(/\bnew\s+HardhatPluginError\s*\(/g)) {
      report(match.index, "new HardhatPluginError()");
    }
    for (const match of code.matchAll(/\bnew\s+((?:[A-Z]\w*)?(?:Error|Failure))\s*\(/g)) {
      if (match[1] === "HardhatPluginError") {
        continue;
      }
      const open = match.index + match[0].length - 1;
      if (!/\bcatalogMessage\s*\(/.test(argumentsAt(code, open))) {
        report(
          match.index,
          `new ${match[1] ?? ""}() with a message that is not from catalogMessage`,
        );
      }
    }
    for (const match of code.matchAll(/\bthrow\s+["'`]/g)) {
      report(match.index, "thrown string");
    }
  }
  return problems.toSorted((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

const pages = markdownFiles("docs");
const problems = [
  ...checkIndexes(pages),
  ...checkSnippets(["README.md", ...packageReadmes(), ...pages]),
  ...(await checkErrorsDoc()),
  ...checkErrorSites(),
];
if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(
  `docs check passed: ${pages.length} pages indexed, snippets typecheck, ${ERRORS_DOC} is current, every error comes from a catalogue\n`,
);
