// Keeps the docs in step with the code:
// - every TypeScript snippet in the READMEs and docs/ typechecks against the built package, the way
//   a user's project imports it (run `pnpm run build` first; `pnpm run docs:check` does), and calls
//   no API marked `@deprecated` (scripts/doc-snippets.ts);
// - every page under docs/ is linked from AGENTS.md and docs/README.md, and every decision record
//   from the decision index, with the exceptions listed in checkIndexes;
// - docs/user/reference/errors.md matches the error catalogues (scripts/generate-errors-doc.ts);
// - docs/user/reference/api/ matches what TypeDoc generates from the built packages
//   (scripts/generate-api-docs.ts); its pages are skipped by the snippet typecheck;
// - first-party source builds its errors only through the catalogue helpers (checkErrorSites);
// - the user docs and the READMEs hold no milestone codes and no HTML comments other than the
//   skip marker and the pre-release note (scripts/user-pages.ts);
// - every ```mermaid block parses with Mermaid's own parser (scripts/mermaid-blocks.ts).
// lychee checks the links themselves (see lychee.toml).
//
// A snippet that is not meant to compile, such as a sketch of a planned API, is preceded by
// `<!-- docs-check: skip -->` on its own line.
//
// Usage: node scripts/check-docs.ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseSync } from "oxc-parser";

import { calleeName, field, walk } from "./ast.ts";
import { checkSnippets, fences } from "./doc-snippets.ts";
import { API_DOCS_COMMAND, API_DOCS_DIR, diffApiDocs, renderApiDocs } from "./generate-api-docs.ts";
import {
  CATALOGUED_DIRECTORIES,
  ERRORS_DOC,
  ERRORS_DOC_COMMAND,
  loadCatalogues,
  renderErrorsDoc,
} from "./generate-errors-doc.ts";
import { mermaidProblems } from "./mermaid-blocks.ts";
import { userPageProblems } from "./user-pages.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function markdownFiles(directory: string): string[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      return markdownFiles(relative);
    }
    return entry.name.endsWith(".md") ? [relative] : [];
  });
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
  const apiIndex = `${API_DOCS_DIR}/README.md`;
  const apiLinks = existsSync(path.join(root, apiIndex)) ? linkTargets(apiIndex) : new Set();
  for (const page of pages) {
    if (page === "docs/README.md" || page === "docs/contributor/decisions/template.md") {
      continue;
    }
    // The generated API pages are linked from their own index, which the two indexes link.
    if (page.startsWith(`${API_DOCS_DIR}/`) && page !== apiIndex) {
      if (!apiLinks.has(page)) {
        problems.push(`${apiIndex} does not link ${page}`);
      }
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

/** Checks the pages a user reads for maintainer content; see `scripts/user-pages.ts`. */
function checkUserPages(files: string[]): string[] {
  return files.flatMap((file) =>
    userPageProblems(file, readFileSync(path.join(root, file), "utf8")),
  );
}

/** Parses every Mermaid block; see `scripts/mermaid-blocks.ts`. */
async function checkMermaid(files: string[]): Promise<string[]> {
  try {
    const blocks = files.flatMap((file) =>
      fences(file)
        .filter((fence) => fence.language === "mermaid")
        .map((fence) => ({ file, line: fence.line, code: fence.code })),
    );
    return await mermaidProblems(blocks);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/** The `name` of every package under packages/, read from its package.json. */
function workspacePackageNames(): Set<string> {
  const names = new Set<string>();
  for (const entry of readdirSync(path.join(root, "packages"), { withFileTypes: true })) {
    const file = path.join(root, "packages", entry.name, "package.json");
    if (!entry.isDirectory() || !existsSync(file)) {
      continue;
    }
    const manifest: unknown = JSON.parse(readFileSync(file, "utf8"));
    const name: unknown =
      typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "name") : undefined;
    if (typeof name === "string") {
      names.add(name);
    }
  }
  return names;
}

/**
 * Fails when the errors page differs from what the catalogues generate, or when one of its `## `
 * headings is not a package name. The second check does not use the generator, so a generator
 * that writes directory names, which differ from the scoped package names, fails even after the
 * page is regenerated.
 */
async function checkErrorsDoc(): Promise<string[]> {
  const expected = renderErrorsDoc(await loadCatalogues());
  const file = path.join(root, ERRORS_DOC);
  const actual = existsSync(file) ? readFileSync(file, "utf8") : "";
  const problems =
    actual === expected
      ? []
      : [`${ERRORS_DOC} is out of date with the error catalogues. Run \`${ERRORS_DOC_COMMAND}\`.`];
  const names = workspacePackageNames();
  for (const line of actual.split("\n")) {
    const heading = line.startsWith("## ") ? line.slice(3).trim() : undefined;
    if (heading !== undefined && !names.has(heading)) {
      problems.push(
        `${ERRORS_DOC}: the heading "## ${heading}" is not the name of a package under packages/`,
      );
    }
  }
  return problems;
}

/** Fails when the API pages differ from what TypeDoc generates. */
function checkApiDocs(): string[] {
  try {
    const problems = diffApiDocs(renderApiDocs());
    return problems.length === 0 ? [] : [...problems, `Run \`${API_DOCS_COMMAND}\`.`];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

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

/** Files that may name `kmsError`: its definition, and the entry point that exports it. */
const KMS_ERROR_FILES = new Set([
  "packages/hardhat-kms/src/internal/errors.ts",
  "packages/hardhat-kms/src/provider-utils.ts",
]);

/** Whether a subtree calls `catalogMessage`. */
function callsCatalogMessage(node: unknown): boolean {
  let found = false;
  walk(node, (child) => {
    if (
      field(child, "type") === "CallExpression" &&
      calleeName(field(child, "callee")) === "catalogMessage"
    ) {
      found = true;
    }
  });
  return found;
}

/** Whether a node is text: a string, a template literal or a `+` with one of them. */
function isText(node: unknown): boolean {
  const type = field(node, "type");
  if (type === "TemplateLiteral") {
    return true;
  }
  if (type === "Literal") {
    return typeof field(node, "value") === "string";
  }
  return (
    type === "BinaryExpression" && (isText(field(node, "left")) || isText(field(node, "right")))
  );
}

/**
 * Whether an argument list passes text directly. Strings inside an options object, such as an SDK
 * command's fields, do not count.
 */
function hasText(args: unknown): boolean {
  return Array.isArray(args) && args.some((arg) => isText(arg));
}

/** An error class: a capitalised name that ends in Error, Failure or Exception. */
const ERROR_NAME = /^(?:[A-Z]\w*)?(?:Error|Failure|Exception)$/;

/**
 * Fails on first-party code that builds an error without the catalogue helpers of
 * packages/hardhat-kms/src/internal/errors.ts. It reads each file's syntax tree, so comments,
 * strings and regular expressions cannot hide or fake a match:
 *
 * - `kmsError` named anywhere (a call, an import, an alias), apart from its definition and export;
 * - `new HardhatPluginError(…)`;
 * - `new X(…)` or `X(…)` where the last segment of `X` ends in `Error`, `Failure` or `Exception`,
 *   such as `new ns.FooError(…)` or a bare `Error(…)`, without `catalogMessage` in its arguments;
 * - `new this.#x(…)` or `new obj.X(…)` with text in its arguments and no `catalogMessage`;
 * - `throw "…"` or ``throw `…` ``.
 */
function checkErrorSites(): string[] {
  const problems: string[] = [];
  const directories = CATALOGUED_DIRECTORIES.map((directory) => path.posix.join(directory, "src"));
  for (const file of directories.flatMap((directory) => sourceFiles(directory))) {
    if (file === ERROR_HELPERS) {
      continue;
    }
    const source = readFileSync(path.join(root, file), "utf8");
    const parsed = parseSync(file, source);
    if (parsed.errors.length > 0) {
      problems.push(`${file}: cannot parse (${parsed.errors[0]?.message ?? "unknown error"})`);
      continue;
    }
    const report = (node: object, what: string): void => {
      const start = field(node, "start");
      const line = source.slice(0, typeof start === "number" ? start : 0).split("\n").length;
      problems.push(
        `${file}:${line}: ${what}; build it from a catalogue entry with catalogError, catalogMessage or internalError`,
      );
    };
    walk(parsed.program, (node) => {
      const type = field(node, "type");
      if (
        type === "Identifier" &&
        field(node, "name") === "kmsError" &&
        !KMS_ERROR_FILES.has(file)
      ) {
        report(node, "kmsError named");
      }
      if (type === "NewExpression" || type === "CallExpression") {
        const callee = field(node, "callee");
        const name = calleeName(callee);
        const args = field(node, "arguments");
        const isNew = type === "NewExpression";
        if (isNew && name === "HardhatPluginError") {
          report(node, "new HardhatPluginError()");
        } else if (name !== undefined && ERROR_NAME.test(name) && !callsCatalogMessage(args)) {
          report(
            node,
            `${isNew ? "new " : ""}${name}() with a message that is not from catalogMessage`,
          );
        } else if (
          isNew &&
          field(callee, "type") === "MemberExpression" &&
          hasText(args) &&
          !callsCatalogMessage(args)
        ) {
          report(node, `new ${name ?? "(computed)"}() with text that is not from catalogMessage`);
        }
      }
      if (type === "ThrowStatement") {
        const argument = field(node, "argument");
        const argumentType = field(argument, "type");
        if (
          argumentType === "TemplateLiteral" ||
          (argumentType === "Literal" && typeof field(argument, "value") === "string")
        ) {
          report(node, "thrown string");
        }
      }
    });
  }
  return problems.toSorted((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

const pages = markdownFiles("docs");
const problems = [
  ...checkIndexes(pages),
  // The API pages' code blocks are signatures and examples from TSDoc, not programs.
  ...checkSnippets([
    "README.md",
    ...packageReadmes(),
    ...pages.filter((page) => !page.startsWith(`${API_DOCS_DIR}/`)),
  ]),
  ...(await checkErrorsDoc()),
  ...checkApiDocs(),
  ...checkErrorSites(),
  ...checkUserPages([
    "README.md",
    ...packageReadmes(),
    ...pages.filter((page) => page.startsWith("docs/user/")),
  ]),
  ...(await checkMermaid(["README.md", ...packageReadmes(), ...pages])),
];
if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(
  `docs check passed: ${pages.length} pages indexed, snippets typecheck and call no deprecated API, ${ERRORS_DOC} and ${API_DOCS_DIR}/ are current, every error comes from a catalogue, user pages hold no maintainer notes, Mermaid blocks parse\n`,
);
