// Keeps the docs in step with the code:
// - every TypeScript snippet in the README and docs/ typechecks against the plugin's source;
// - every page under docs/ is linked from AGENTS.md and from docs/README.md.
// Links are checked separately, with lychee (see .github/workflows).
//
// A snippet that is not meant to compile, such as a sketch of a planned API, is preceded by
// `<!-- docs-check: skip -->` on its own line.
//
// Usage: node scripts/check-docs.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_MARKER = "<!-- docs-check: skip -->";

function markdownFiles(directory: string): string[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      return markdownFiles(relative);
    }
    return entry.name.endsWith(".md") ? [relative] : [];
  });
}

/** Extracts the ```ts blocks of a Markdown file, except those preceded by the skip marker. */
function snippets(file: string): Array<{ line: number; code: string }> {
  const lines = readFileSync(path.join(root, file), "utf8").split("\n");
  const found: Array<{ line: number; code: string }> = [];
  for (let index = 0; index < lines.length; index++) {
    if (!/^```ts\b/.test(lines[index] ?? "")) {
      continue;
    }
    const skipped =
      lines
        .slice(0, index)
        .findLast((line) => line.trim() !== "")
        ?.trim() === SKIP_MARKER;
    const end = lines.findIndex((line, at) => at > index && line.startsWith("```"));
    if (end === -1) {
      throw new Error(`${file}:${index + 1}: unterminated code block`);
    }
    if (!skipped) {
      found.push({ line: index + 1, code: lines.slice(index + 1, end).join("\n") });
    }
    index = end;
  }
  return found;
}

function checkSnippets(files: string[]): string[] {
  const directory = path.join(root, ".docs-check");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const sources = new Map<string, string>();
  for (const file of files) {
    for (const { line, code } of snippets(file)) {
      const name = `${file.replaceAll(/[/.]/g, "_")}_L${line}.ts`;
      // `export {}` makes every snippet a module, so their top-level names cannot clash.
      writeFileSync(path.join(directory, name), `${code}\nexport {};\n`);
      sources.set(name, `${file}:${line}`);
    }
  }
  writeFileSync(
    path.join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "nodenext",
        moduleResolution: "nodenext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        types: ["node"],
        // Snippets import the package by name; check them against its source.
        paths: { "hardhat-kms": ["../src/index.ts"], "hardhat-kms/types": ["../src/types.ts"] },
      },
      include: ["*.ts"],
    }),
  );
  try {
    execFileSync(
      process.execPath,
      [path.join(root, "node_modules/typescript/bin/tsc"), "-p", directory],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    return [];
  } catch (error) {
    const output =
      typeof error === "object" && error !== null && "stdout" in error
        ? String(error.stdout)
        : String(error);
    // Point errors at the Markdown file and line the snippet came from.
    return output
      .split("\n")
      .filter((line) => line.includes("error TS"))
      .map((line) => {
        const match = /^\.docs-check\/([^(]+)\((\d+),\d+\)(.*)$/.exec(line.trim());
        if (match === null) {
          return line;
        }
        const [, name = "", offset = "0", rest = ""] = match;
        const [file = name, start = "0"] = (sources.get(name) ?? name).split(":");
        return `${file}:${Number(start) + Number(offset)}${rest}`;
      });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function checkIndexes(pages: string[]): string[] {
  const agents = readFileSync(path.join(root, "AGENTS.md"), "utf8");
  const docsIndex = readFileSync(path.join(root, "docs/README.md"), "utf8");
  const problems: string[] = [];
  for (const page of pages) {
    const fromDocs = page.slice("docs/".length);
    if (page === "docs/README.md" || page.endsWith("/template.md")) {
      continue;
    }
    if (!agents.includes(`(${page})`) && !agents.includes(`(${page}#`)) {
      problems.push(`AGENTS.md does not link ${page}`);
    }
    // Decision records are listed in their own index, which docs/README.md links.
    const listedElsewhere =
      page.startsWith("docs/contributor/decisions/0") || page === "docs/DESIGN.md";
    if (
      !listedElsewhere &&
      !docsIndex.includes(`(${fromDocs})`) &&
      !docsIndex.includes(`(${fromDocs}#`)
    ) {
      problems.push(`docs/README.md does not link ${fromDocs}`);
    }
  }
  return problems;
}

const pages = markdownFiles("docs");
const problems = [...checkIndexes(pages), ...checkSnippets(["README.md", ...pages])];
if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`docs check passed: ${pages.length} pages indexed, snippets typecheck\n`);
