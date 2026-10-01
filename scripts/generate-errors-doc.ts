// Writes docs/user/reference/errors.md from the error catalogues of the built packages
// (packages/*/dist/src/internal/error-catalog.js): one table per package and group, one row per
// entry. Run it with `pnpm run docs:errors`, which builds first. scripts/check-docs.ts calls
// renderErrorsDoc() and fails when the page differs.
//
// Usage: node scripts/generate-errors-doc.ts
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Where the page lives, relative to the repository root. */
export const ERRORS_DOC = "docs/user/reference/errors.md";

/** The command that regenerates the page. */
export const ERRORS_DOC_COMMAND = "pnpm run docs:errors";

const KINDS = ["error", "validation", "reason", "internal"] as const;
type Kind = (typeof KINDS)[number];

/** A catalogue entry, as read from a built package. */
export interface CatalogueEntry {
  id: string;
  kind: Kind;
  group: string;
  template: string;
  cause: string;
  fix: string;
}

/** One package's catalogue. */
export interface Catalogue {
  packageName: string;
  entries: CatalogueEntry[];
}

const KIND_NAMES: Record<Kind, string> = {
  error: "error",
  validation: "config",
  reason: "reason",
  internal: "internal",
};

function parseKind(value: unknown): Kind | undefined {
  return KINDS.find((kind) => kind === value);
}

/** Reads one entry, checking every field, so a malformed catalogue fails with its position. */
function parseEntry(value: unknown, where: string): CatalogueEntry {
  const field = (name: string): string => {
    const text: unknown =
      typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
    if (typeof text !== "string" || text.trim() === "") {
      throw new Error(`${where}: the entry has no ${name}`);
    }
    return text;
  };
  const kind = parseKind(field("kind"));
  if (kind === undefined) {
    throw new Error(`${where}: unknown kind ${field("kind")}`);
  }
  return {
    id: field("id"),
    kind,
    group: field("group"),
    template: field("template"),
    cause: field("cause"),
    fix: field("fix"),
  };
}

/** The workspace packages, the core first, then the providers by name. */
function packageNames(): string[] {
  return readdirSync(path.join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((a, b) => (a === "hardhat-kms" ? -1 : b === "hardhat-kms" ? 1 : a.localeCompare(b)));
}

/**
 * Loads the error catalogue of every built package that has one.
 *
 * @returns The catalogues, the core first.
 */
export async function loadCatalogues(): Promise<Catalogue[]> {
  const catalogues: Catalogue[] = [];
  for (const packageName of packageNames()) {
    const file = path.join(root, "packages", packageName, "dist/src/internal/error-catalog.js");
    if (!existsSync(file)) {
      continue;
    }
    const module: unknown = await import(pathToFileURL(file).href);
    const errors: unknown =
      typeof module === "object" && module !== null ? Reflect.get(module, "ERRORS") : undefined;
    if (typeof errors !== "object" || errors === null) {
      throw new Error(`${packageName}: error-catalog.js exports no ERRORS object`);
    }
    const entries = Object.entries(errors).map(([key, value]) =>
      parseEntry(value, `${packageName} ERRORS.${key}`),
    );
    catalogues.push({ packageName, entries });
  }
  return catalogues;
}

/** Escapes text for a Markdown table cell. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

/** A code span that holds any text, backticks included. */
function code(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  const padded = longest > 0 || text.startsWith(" ") || text.endsWith(" ") ? ` ${text} ` : text;
  return `${fence}${cell(padded)}${fence}`;
}

/**
 * Renders the page from the catalogues and formats it as `pnpm run format` would.
 *
 * @param catalogues - The catalogues, from {@link loadCatalogues}.
 * @returns The page.
 */
export function renderErrorsDoc(catalogues: Catalogue[]): string {
  const lines = [
    "# Errors",
    "",
    "Audience: anyone who got an error from hardhat-kms or one of its provider packages.",
    "",
    `Status: generated from the error catalogues (\`packages/*/src/internal/error-catalog.ts\`) by \`${ERRORS_DOC_COMMAND}\`. Do not edit it by hand; \`pnpm run docs:check\` fails when it is out of date.`,
    "",
    "Every error the plugin builds has an entry here, with a stable id. Find an error by searching for a fixed part of its message.",
    "",
    "- `{name}` in a message stands for a value, such as an address or a file name.",
    "- Most errors start with the provider, the operation and the key, for example `aws, sign, key aws:alias/deployer: the provider call failed (AccessDeniedException)`. The tables list the part after that prefix.",
    "- Kind `config`: a config validation message. Hardhat shows it in its `Invalid config` error, after the config path, for example `* Config error in config.kms.keys.deployer.address: …`.",
    "- Kind `reason`: text that another error includes, such as the reason in `the provider returned an invalid signature ({reason})`.",
    "- Kind `internal`: a plain `Error` that only a bug or a broken install can cause.",
    "",
    "Errors never include credentials or the text of an SDK error, which can carry request details. Run with `DEBUG=hardhat:kms:*` to see each step; see [Debug output](../guides/debug-output.md).",
  ];
  for (const { packageName, entries } of catalogues) {
    lines.push("", `## ${packageName}`);
    const groups = [...new Set(entries.map((entry) => entry.group))];
    for (const group of groups) {
      lines.push(
        "",
        `### ${group}`,
        "",
        "| Id | Kind | Message | Cause | Fix |",
        "| --- | --- | --- | --- | --- |",
      );
      for (const entry of entries.filter((candidate) => candidate.group === group)) {
        lines.push(
          `| \`${entry.id}\` | ${KIND_NAMES[entry.kind]} | ${code(entry.template)} | ${cell(entry.cause)} | ${cell(entry.fix)} |`,
        );
      }
    }
  }
  const markdown = `${lines.join("\n")}\n`;
  const formatted = spawnSync(
    path.join(root, "node_modules/.bin", process.platform === "win32" ? "oxfmt.cmd" : "oxfmt"),
    [`--stdin-filepath=${ERRORS_DOC}`],
    { cwd: root, input: markdown, encoding: "utf8", shell: process.platform === "win32" },
  );
  if (formatted.status !== 0) {
    throw new Error(`oxfmt failed: ${formatted.stderr}`);
  }
  return formatted.stdout;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const catalogues = await loadCatalogues();
  writeFileSync(path.join(root, ERRORS_DOC), renderErrorsDoc(catalogues));
  const count = catalogues.reduce((total, catalogue) => total + catalogue.entries.length, 0);
  process.stdout.write(
    `wrote ${ERRORS_DOC}: ${count} entries from ${catalogues.length} packages\n`,
  );
}
