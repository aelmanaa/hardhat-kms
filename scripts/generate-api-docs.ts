// Writes the API reference, docs/user/reference/api/, with TypeDoc from the built `.d.ts` file of
// each export of hardhat-kms (decision 0012). TypeDoc runs from tools/api-docs, which has
// TypeScript 6; its options are in tools/api-docs/typedoc.jsonc. Run it with `pnpm run docs:api`.
// renderApiDocs() brings the packages' dist/ up to date with `tsc -b` first, so the pages never
// come from a stale build. scripts/check-docs.ts calls it and fails when a page differs.
//
// The provider packages are not documented here: each exports only its plugin, a `HardhatPlugin`,
// and checkProviderExports() fails if one starts to export anything else.
//
// Each page starts with frontmatter (scripts/frontmatter.ts): its H1 as `title`, and the
// description from API_DESCRIPTIONS, which a new module's page needs before it can be generated.
//
// Usage: node scripts/generate-api-docs.ts
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { parseSync } from "oxc-parser";

import { firstHeading, renderFrontmatter } from "./frontmatter.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shell = process.platform === "win32";
const bin = (name: string): string =>
  path.join(root, "node_modules", ".bin", shell ? `${name}.cmd` : name);

/** Where the pages live, relative to the repository root. */
export const API_DOCS_DIR = "docs/user/reference/api";

/** The command that regenerates the pages. */
export const API_DOCS_COMMAND = "pnpm run docs:api";

const TOOLS = path.join(root, "tools/api-docs");
const CORE = "packages/hardhat-kms";

/** Reads a field of a parsed JSON value. */
function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(path.join(root, file), "utf8"));
}

/** The `exports` keys of a package, apart from `./package.json`. */
function exportKeys(packageDirectory: string): string[] {
  const exports = field(readJson(`${packageDirectory}/package.json`), "exports");
  if (typeof exports !== "object" || exports === null) {
    throw new Error(`${packageDirectory}/package.json has no exports map`);
  }
  return Object.keys(exports).filter((key) => key !== "./package.json");
}

/** The built `.d.ts` file of one export of a package, relative to the repository root. */
function typesFile(packageDirectory: string, key: string): string {
  const exports = field(readJson(`${packageDirectory}/package.json`), "exports");
  const types = field(field(exports, key), "types");
  if (typeof types !== "string") {
    throw new Error(`${packageDirectory}/package.json: export ${key} has no types condition`);
  }
  return path.posix.join(packageDirectory, types);
}

/** The built `.d.ts` file of each export of hardhat-kms, from its package.json. */
function entryPoints(): string[] {
  return exportKeys(CORE).map((key) => path.join(root, typesFile(CORE, key)));
}

/** The workspace packages under packages/, relative to the repository root. */
function workspacePackages(): string[] {
  return readdirSync(path.join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`);
}

/**
 * Fails when a provider package exports more than its plugin: a second export in package.json, or
 * a named export from its entry point. Such an export would need a page here.
 */
export function checkProviderExports(): void {
  const providers = workspacePackages().filter((directory) => directory !== CORE);
  const problems: string[] = [];
  for (const directory of providers) {
    const keys = exportKeys(directory);
    if (keys.length !== 1 || keys[0] !== ".") {
      problems.push(`${directory}/package.json exports ${keys.join(", ")}`);
      continue;
    }
    const file = typesFile(directory, ".");
    const parsed = parseSync(file, readFileSync(path.join(root, file), "utf8"));
    for (const statement of parsed.program.body) {
      if (
        statement.type === "ExportNamedDeclaration" ||
        statement.type === "ExportAllDeclaration" ||
        statement.type === "TSExportAssignment"
      ) {
        problems.push(`${file} has an export other than the default plugin`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `${problems.join("\n")}\nDocument the provider package's exports in scripts/generate-api-docs.ts`,
    );
  }
}

/**
 * The frontmatter description of each page, by its path relative to {@link API_DOCS_DIR}: one
 * sentence for the docs site's meta description and search index.
 */
const API_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "README.md":
    "The TypeScript API of hardhat-kms, generated from TSDoc: the plugin export, the config types and the helpers for provider plugins.",
  "hardhat-kms.md":
    "The hardhat-kms entry point: the plugin as its default export, which adds the kms config section and each network's kmsAccounts.",
  "hardhat-kms/provider-utils.md":
    "The experimental hardhat-kms/provider-utils helpers that the first-party provider packages build on and third-party providers may use.",
  "hardhat-kms/types.md":
    "Public types of hardhat-kms/types: the kms config section, each provider's key config and the resolved forms Hardhat passes to plugins.",
};

/** Puts a page's frontmatter before its H1; fails for a page without a description. */
function withFrontmatter(file: string, markdown: string): string {
  const description = API_DESCRIPTIONS[file];
  const title = firstHeading(markdown);
  if (description === undefined || title === undefined) {
    throw new Error(
      `${path.posix.join(API_DOCS_DIR, file)} has ${title === undefined ? "no H1" : "no description"}; add one to API_DESCRIPTIONS in scripts/generate-api-docs.ts`,
    );
  }
  return `${renderFrontmatter({ title, description })}${markdown}`;
}

/** The top of the index page, above TypeDoc's list of modules. */
const INTRO = [
  "# API reference",
  "",
  "Audience: anyone who imports from `hardhat-kms` in TypeScript, or writes a provider package.",
  "",
  "These pages are generated from the documentation comments of the published type declarations, so they describe the code of this version. Anything marked `Experimental` is outside the public API and may change in a minor.",
  "",
  "The plugin is configured, not called: [Configuration](../configuration.md) describes each config field. The provider packages export only their plugin, so they have no page here.",
].join("\n");

function formatMarkdown(file: string, markdown: string): string {
  const formatted = spawnSync(bin("oxfmt"), [`--stdin-filepath=${file}`], {
    cwd: root,
    input: markdown,
    encoding: "utf8",
    shell,
  });
  if (formatted.status !== 0) {
    throw new Error(`oxfmt failed on ${file}: ${formatted.stderr}`);
  }
  return formatted.stdout;
}

function markdownFiles(directory: string, relative = ""): string[] {
  return readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap((entry) => {
    const child = path.posix.join(relative, entry.name);
    return entry.isDirectory() ? markdownFiles(directory, child) : [child];
  });
}

/** Builds every package with `tsc -b`, which only rebuilds what changed. */
function buildPackages(): void {
  const projects = workspacePackages().map((directory) => `${directory}/tsconfig.build.json`);
  const built = spawnSync(
    process.execPath,
    [path.join(root, "node_modules/typescript/bin/tsc"), "-b", ...projects],
    { cwd: root, encoding: "utf8" },
  );
  if (built.status !== 0) {
    throw new Error(
      `tsc -b failed (exit ${String(built.status)})${built.error === undefined ? "" : `: ${built.error.message}`}\n${built.stdout}${built.stderr}`.trim(),
    );
  }
}

/**
 * Builds the packages, runs TypeDoc into a temporary directory and formats each page as
 * `pnpm run format` would.
 *
 * @returns Each page's content, by its path relative to {@link API_DOCS_DIR}.
 */
export function renderApiDocs(): Map<string, string> {
  buildPackages();
  checkProviderExports();
  const out = mkdtempSync(path.join(tmpdir(), "hardhat-kms-api-docs-"));
  try {
    const typedoc = spawnSync(
      process.execPath,
      [
        path.join(TOOLS, "node_modules/typedoc/bin/typedoc"),
        "--options",
        "typedoc.jsonc",
        "--out",
        out,
        "--logLevel",
        "Warn",
        ...entryPoints().flatMap((entry) => ["--entryPoints", entry]),
      ],
      {
        cwd: TOOLS,
        encoding: "utf8",
        // TypeDoc builds anchors with toLocaleLowerCase, so under a Turkish or Azerbaijani locale
        // `I` becomes a dotless `ı` and every page would differ. The C locale keeps them stable.
        // oxlint-disable-next-line node/no-process-env -- passes the environment on, with a fixed locale
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      },
    );
    if (typedoc.status !== 0) {
      const output = stripVTControlCharacters(`${typedoc.stdout}${typedoc.stderr}`).trim();
      throw new Error(
        `TypeDoc failed (exit ${String(typedoc.status)})${typedoc.error === undefined ? "" : `: ${typedoc.error.message}`}\n${output}`,
      );
    }
    const pages = new Map<string, string>();
    for (const file of markdownFiles(out).toSorted()) {
      let markdown = readFileSync(path.join(out, file), "utf8");
      if (file === "README.md") {
        markdown = markdown.replace(/^# .*\n/, `${INTRO}\n`);
      }
      pages.set(
        file,
        formatMarkdown(path.posix.join(API_DOCS_DIR, file), withFrontmatter(file, markdown)),
      );
    }
    return pages;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/**
 * Compares the committed pages with freshly rendered ones.
 *
 * @param expected - The pages, from {@link renderApiDocs}.
 * @returns One line per page that is missing, extra or different.
 */
export function diffApiDocs(expected: Map<string, string>): string[] {
  const directory = path.join(root, API_DOCS_DIR);
  const actual = existsSync(directory) ? markdownFiles(directory) : [];
  const problems: string[] = [];
  for (const [file, content] of expected) {
    const target = path.posix.join(API_DOCS_DIR, file);
    if (!actual.includes(file)) {
      problems.push(`${target} is missing`);
    } else if (readFileSync(path.join(directory, file), "utf8") !== content) {
      problems.push(`${target} is out of date`);
    }
  }
  for (const file of actual) {
    if (!expected.has(file)) {
      problems.push(`${path.posix.join(API_DOCS_DIR, file)} is not generated any more`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pages = renderApiDocs();
  const directory = path.join(root, API_DOCS_DIR);
  rmSync(directory, { recursive: true, force: true });
  for (const [file, content] of pages) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), content);
  }
  process.stdout.write(`wrote ${API_DOCS_DIR}: ${pages.size} pages\n`);
}
