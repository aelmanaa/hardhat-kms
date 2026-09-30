// Keeps the docs in step with the code:
// - every TypeScript snippet in the READMEs and docs/ typechecks against the built package, the way
//   a user's project imports it (run `pnpm run build` first; `pnpm run docs:check` does);
// - every page under docs/ is linked from AGENTS.md and docs/README.md, and every decision record
//   from the decision index, with the exceptions listed in checkIndexes.
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

const pages = markdownFiles("docs");
const problems = [
  ...checkIndexes(pages),
  ...checkSnippets(["README.md", ...packageReadmes(), ...pages]),
];
if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`docs check passed: ${pages.length} pages indexed, snippets typecheck\n`);
