// Fails when a package that npm marks as deprecated is in the production dependency tree of a
// published package, unless ALLOWED lists it. Part of `pnpm run pkg:check`; it makes no request:
//
// - the deprecated packages are the `deprecated:` entries of the `packages:` section of
//   pnpm-lock.yaml, which pnpm copies from the registry when it resolves a version;
// - the production tree is `pnpm list -r --prod --json --depth Infinity` over packages/, which
//   reads the installed dependencies (`dependencies` and `optionalDependencies`, not dev or peer).
//
// A deprecated package that only the development tree has (tooling, tests, examples) is printed,
// and does not fail: users never install it.
//
// Usage: node scripts/check-deprecated-packages.ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A deprecated package that may stay in a production tree, with why and where to follow it. */
export interface AllowedDeprecation {
  /** The package name; any version matches. */
  name: string;
  reason: string;
  /** The upstream issue or pull request that tracks its removal. */
  link: string;
}

export const ALLOWED: readonly AllowedDeprecation[] = [
  {
    name: "node-domexception",
    reason:
      "@hardhat-kms/gcp gets it from Google's client libraries: gaxios 7, then node-fetch 3 and fetch-blob. The latest gaxios still depends on node-fetch, and google-auth-library 11 pins gaxios ^7, so no upstream release drops it. On Node 22 and later it only re-exports the built-in DOMException; npm prints a warning on install.",
    link: "https://github.com/googleapis/google-cloud-node/issues/7221",
  },
];

/** Removes the YAML quotes around a plain scalar of pnpm-lock.yaml. */
function unquote(value: string): string {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  }
  return value;
}

/**
 * Reads the `deprecated:` entries of the `packages:` section of a pnpm v9 lockfile, keyed by
 * `name@version`. The section lists each resolved version once, two spaces in, with its fields
 * four spaces in.
 */
export function deprecatedPackages(lockfile: string): Map<string, string> {
  const found = new Map<string, string>();
  let section = "";
  let key: string | undefined;
  for (const line of lockfile.split(/\r?\n/)) {
    const top = /^(\S[^:]*):/.exec(line);
    if (top !== null) {
      section = top[1] ?? "";
      key = undefined;
      continue;
    }
    if (section !== "packages") {
      continue;
    }
    const entry = /^ {2}(\S.*):$/.exec(line);
    if (entry !== null) {
      key = unquote(entry[1] ?? "");
      continue;
    }
    const deprecated = /^ {4}deprecated: (.*)$/.exec(line);
    if (deprecated !== null && key !== undefined) {
      found.set(key, unquote(deprecated[1] ?? ""));
    }
  }
  return found;
}

/** Reads a field of a parsed JSON value. */
function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

/**
 * Walks the output of `pnpm list -r --prod --json --depth Infinity` and returns, for each
 * `name@version` it reaches from a published (not private) workspace package, the first chain of
 * packages that leads to it, such as `@hardhat-kms/gcp > gaxios > node-fetch`.
 */
export function productionChains(list: unknown): Map<string, string> {
  const chains = new Map<string, string>();
  const visit = (dependencies: unknown, chain: string): void => {
    if (typeof dependencies !== "object" || dependencies === null) {
      return;
    }
    for (const [alias, node] of Object.entries(dependencies)) {
      const from = field(node, "from");
      const name = typeof from === "string" ? from : alias;
      const version = field(node, "version");
      // A workspace package is linked, not installed from the registry.
      if (typeof version !== "string" || version.startsWith("link:")) {
        continue;
      }
      const next = `${chain} > ${name}`;
      const key = `${name}@${version}`;
      if (!chains.has(key)) {
        chains.set(key, next);
      }
      visit(field(node, "dependencies"), next);
      visit(field(node, "optionalDependencies"), next);
    }
  };
  for (const project of Array.isArray(list) ? list : []) {
    const name = field(project, "name");
    if (field(project, "private") === true || typeof name !== "string") {
      continue;
    }
    visit(field(project, "dependencies"), name);
    visit(field(project, "optionalDependencies"), name);
  }
  return chains;
}

/** The name of a `name@version` key; scoped names start with `@`. */
function packageName(key: string): string {
  return key.slice(0, key.lastIndexOf("@"));
}

export interface DeprecationReport {
  /** Lines that fail the check. */
  problems: string[];
  /** Lines printed for information. */
  notes: string[];
}

/**
 * Sorts each deprecated package into a failure (production tree, not allowed), a note (allowed,
 * or development only) and reports allowlist entries that no longer match a production package.
 */
export function classify(
  deprecated: Map<string, string>,
  production: Map<string, string>,
  allowed: readonly AllowedDeprecation[] = ALLOWED,
): DeprecationReport {
  const problems: string[] = [];
  const notes: string[] = [];
  const used = new Set<string>();
  for (const [key, message] of [...deprecated].toSorted(([a], [b]) => a.localeCompare(b))) {
    const chain = production.get(key);
    const allowance = allowed.find((entry) => entry.name === packageName(key));
    if (chain === undefined) {
      notes.push(`${key} is deprecated, in the development tree only: ${message}`);
    } else if (allowance === undefined) {
      problems.push(
        `${key} is deprecated and in a published package's production tree (${chain}): ${message}`,
      );
    } else {
      used.add(allowance.name);
      notes.push(`${key} is deprecated, allowed (${chain}): ${allowance.link}`);
    }
  }
  for (const entry of allowed) {
    if (!used.has(entry.name)) {
      problems.push(
        `${entry.name} is in ALLOWED in scripts/check-deprecated-packages.ts, but no published package's production tree has a deprecated version of it; remove the entry`,
      );
    }
  }
  return { problems, notes };
}

function main(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const lockfile = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
  const listed = execFileSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["list", "-r", "--prod", "--json", "--depth", "Infinity", "--filter", "./packages/*"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === "win32",
    },
  );
  const list: unknown = JSON.parse(listed);
  const report = classify(deprecatedPackages(lockfile), productionChains(list));
  for (const note of report.notes) {
    process.stdout.write(`${note}\n`);
  }
  if (report.problems.length > 0) {
    process.stderr.write(`${report.problems.join("\n")}\n`);
    process.stderr.write(
      "Replace or update the dependency that brings it in. If no upstream fix exists, add it to ALLOWED with the reason and the upstream link.\n",
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    "deprecated packages check passed: no unlisted deprecated package in a published package's production tree\n",
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
