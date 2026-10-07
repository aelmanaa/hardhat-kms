// Fails when a fresh install of a provider package with the core gives a user a deprecated
// package, unless ALLOWED in scripts/check-deprecated-packages.ts lists it. The lockfile check of
// `pnpm run pkg:check` cannot see this: pnpm writes `deprecated:` into the lockfile only when it
// resolves a version, and a project that installs the packages from npm resolves every range again.
//
// For each provider package and each of npm and pnpm, the script installs the packed provider
// package and the packed core into an empty project with an empty npm cache, pnpm store and pnpm
// metadata cache, so the package manager reads the registry's current metadata. It then walks the
// production tree the way Node resolves it, from the two packages through `dependencies` and
// `optionalDependencies` (not the peers Hardhat and viem, which the user's project chooses), and
// asks the registry whether each version it finds is deprecated. A nested second copy counts as
// well as a hoisted one.
//
// The installs and the registry questions need the network; each registry request is tried three
// times. Runs weekly, in the release workflow's pack job and on pull requests that change a
// published package.json (fresh-install.yml). Not a required check: a deprecation on the registry
// would fail pull requests that changed nothing.
//
// Usage: node scripts/check-fresh-install.ts [--summary <file>] [--from-registry <version> [--registry <url>]]
//   --summary appends the result table to a file, such as $GITHUB_STEP_SUMMARY. --from-registry
//   installs the published packages at that version instead of packing the workspace, with no
//   build. --registry points the installs and the deprecation questions at another registry.
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { field } from "./ast.ts";
import { ALLOWED, type AllowedDeprecation } from "./check-deprecated-packages.ts";
import { PACKAGES, assertInstalledVersion, registryOptionsOrExit } from "./registry.ts";
import { readJson, resolvedVersion, root, run, stringRecord } from "./temporary-install.ts";

/** The registry the deprecation questions go to when `--registry` is not given. */
const NPM_REGISTRY = "https://registry.npmjs.org";
/** The provider packages, with their directories in packages/. */
const PROVIDERS = [
  { name: "@hardhat-kms/aws", directory: "hardhat-kms-aws" },
  { name: "@hardhat-kms/gcp", directory: "hardhat-kms-gcp" },
  { name: "@hardhat-kms/azure", directory: "hardhat-kms-azure" },
] as const;
const MANAGERS = ["npm", "pnpm"] as const;
type Manager = (typeof MANAGERS)[number];
/** An install that takes longer than this fails. */
const INSTALL_TIMEOUT_MS = 600_000;
/** Registry requests run at most this many at a time, and each is tried this many times. */
const CONCURRENCY = 8;
const ATTEMPTS = 3;

/** The real directory of `name` as Node resolves it from `from`, or undefined. */
function locate(from: string, name: string): string | undefined {
  for (let folder = from; ; folder = path.dirname(folder)) {
    const candidate = path.join(folder, "node_modules", ...name.split("/"));
    if (existsSync(path.join(candidate, "package.json"))) {
      return realpathSync(candidate);
    }
    if (path.dirname(folder) === folder) {
      return undefined;
    }
  }
}

/**
 * Walks a project's installed production tree from `roots`, the way Node resolves a bare
 * specifier: for each package, `node_modules/<dependency>` in its real directory and each parent.
 * pnpm's symlinks are followed to the real directory, so a package's dependencies are found next
 * to it in the store layout as well as in npm's hoisted one. An optional dependency that is not
 * installed (another platform's binary) is skipped; a missing regular dependency throws.
 *
 * @param project - The project directory, with its node_modules.
 * @param roots - The packages the walk starts from, which the project depends on.
 * @returns For each `name@version` reached, the first chain of packages that leads to it, such as
 * `@hardhat-kms/gcp > google-gax`. The roots are not in it.
 */
export function productionTree(project: string, roots: readonly string[]): Map<string, string> {
  const chains = new Map<string, string>();
  const visited = new Set<string>();
  const queue: { directory: string; chain: string }[] = [];
  for (const name of roots) {
    const directory = locate(realpathSync(project), name);
    if (directory === undefined) {
      throw new Error(`${name} is not installed in ${project}`);
    }
    visited.add(directory);
    queue.push({ directory, chain: name });
  }
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const manifest = readJson(path.join(next.directory, "package.json"));
    const required = Object.keys(stringRecord(manifest.dependencies));
    const optional = Object.keys(stringRecord(manifest.optionalDependencies));
    for (const name of new Set([...required, ...optional])) {
      const directory = locate(next.directory, name);
      if (directory === undefined) {
        if (optional.includes(name)) {
          continue;
        }
        throw new Error(`${next.chain} depends on ${name}, which is not installed`);
      }
      const installed = readJson(path.join(directory, "package.json"));
      const key = `${String(installed.name)}@${String(installed.version)}`;
      const chain = `${next.chain} > ${String(installed.name)}`;
      if (!chains.has(key)) {
        chains.set(key, chain);
      }
      if (!visited.has(directory)) {
        visited.add(directory);
        queue.push({ directory, chain });
      }
    }
  }
  return chains;
}

/**
 * The deprecated versions in a registry document (the abbreviated or the full packument).
 *
 * @param packument - The parsed document.
 * @returns The deprecation message of each deprecated version, keyed by version.
 */
export function deprecatedVersions(packument: unknown): Map<string, string> {
  const found = new Map<string, string>();
  const versions = field(packument, "versions");
  if (typeof versions !== "object" || versions === null) {
    throw new Error("the registry document has no versions");
  }
  for (const [version, manifest] of Object.entries(versions)) {
    const message = field(manifest, "deprecated");
    // npm un-deprecates a version by setting an empty message.
    if (typeof message === "string" && message !== "") {
      found.set(version, message);
    }
  }
  return found;
}

/** The name of a `name@version` key; scoped names start with `@`. */
function nameOf(key: string): string {
  return key.slice(0, key.lastIndexOf("@"));
}

/**
 * Asks the registry, through `fetchPackument`, whether each version is deprecated.
 *
 * @param keys - The `name@version` keys to check.
 * @param fetchPackument - Returns a package's registry document; each name is fetched once.
 * @returns The deprecation message of each deprecated key.
 * @throws When the registry has no document for a name, or not the version that was installed.
 */
export async function registryDeprecations(
  keys: Iterable<string>,
  fetchPackument: (name: string) => Promise<unknown>,
): Promise<Map<string, string>> {
  const byName = new Map<string, string[]>();
  for (const key of keys) {
    const name = nameOf(key);
    byName.set(name, [...(byName.get(name) ?? []), key.slice(name.length + 1)]);
  }
  const names = [...byName.keys()];
  const found = new Map<string, string>();
  const worker = async (): Promise<void> => {
    for (let name = names.shift(); name !== undefined; name = names.shift()) {
      const packument = await fetchPackument(name);
      const listed = field(packument, "versions");
      const deprecated = deprecatedVersions(packument);
      for (const version of byName.get(name) ?? []) {
        if (field(listed, version) === undefined) {
          throw new Error(`the registry lists no ${name}@${version}, which the install resolved`);
        }
        const message = deprecated.get(version);
        if (message !== undefined) {
          found.set(`${name}@${version}`, message);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return found;
}

/** What the check found in one install. */
export interface FreshReport {
  /** Lines that fail the check. */
  problems: string[];
  /** Lines printed for information. */
  notes: string[];
}

/**
 * Sorts the deprecated packages of one install's production tree into failures and allowed ones.
 *
 * @param label - The install, such as `@hardhat-kms/gcp with npm`.
 * @param tree - From {@link productionTree}.
 * @param deprecated - From {@link registryDeprecations}, for this tree or more.
 * @param allowed - The allowed deprecated packages.
 */
export function classifyFresh(
  label: string,
  tree: ReadonlyMap<string, string>,
  deprecated: ReadonlyMap<string, string>,
  allowed: readonly AllowedDeprecation[] = ALLOWED,
): FreshReport {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const [key, chain] of [...tree].toSorted(([a], [b]) => a.localeCompare(b))) {
    const message = deprecated.get(key);
    if (message === undefined) {
      continue;
    }
    const allowance = allowed.find((entry) => entry.name === nameOf(key));
    if (allowance === undefined) {
      problems.push(
        `${label}: ${key} is deprecated (${chain}): ${message.replace(/\.$/, "")}. Exclude the version in the range that brings it in, or move to a release that drops it; if no upstream release does, add it to ALLOWED in scripts/check-deprecated-packages.ts with the reason and the upstream link`,
      );
    } else {
      notes.push(`${label}: ${key} is deprecated, allowed (${chain}): ${allowance.link}`);
    }
  }
  return { problems, notes };
}

/** Fetches a package's abbreviated registry document, trying a failed request again. */
async function fetchFromRegistry(registry: string, name: string): Promise<unknown> {
  const url = `${registry.replace(/\/+$/, "")}/${name.replace("/", "%2f")}`;
  let failure = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        const document: unknown = await response.json();
        return document;
      }
      failure = `HTTP ${response.status}`;
      // A missing package will not appear on a second try.
      if (response.status === 404) {
        break;
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
  throw new Error(`${url}: ${failure}`);
}

/**
 * Runs a package manager in a scratch project with its own caches, with no update notices or
 * audits. pnpm reads its store and metadata cache from the project's pnpm-workspace.yaml.
 */
function install(manager: Manager, directory: string, caches: string, registry?: string): void {
  const registryArgs = registry === undefined ? [] : ["--registry", registry];
  if (manager === "pnpm") {
    // JSON strings are valid YAML scalars, whatever the path holds.
    writeFileSync(
      path.join(directory, "pnpm-workspace.yaml"),
      `storeDir: ${JSON.stringify(path.join(caches, "pnpm-store"))}\ncacheDir: ${JSON.stringify(path.join(caches, "pnpm-cache"))}\n`,
    );
  }
  const args =
    manager === "npm"
      ? [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--no-update-notifier",
          "--cache",
          path.join(caches, "npm"),
        ]
      : ["install", "--ignore-scripts"];
  execFileSync(
    process.platform === "win32" ? `${manager}.cmd` : manager,
    [...args, ...registryArgs],
    {
      cwd: directory,
      stdio: ["ignore", "ignore", "inherit"],
      timeout: INSTALL_TIMEOUT_MS,
      shell: process.platform === "win32",
    },
  );
}

/** The version a package manager prints. */
function toolVersion(manager: Manager): string {
  return execFileSync(process.platform === "win32" ? `${manager}.cmd` : manager, ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  }).trim();
}

/** Packs a workspace package and returns the tarball path. */
function pack(directory: string, destination: string): string {
  const parsed: unknown = JSON.parse(
    execFileSync(
      process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      ["pack", "--json", "--pack-destination", destination],
      { cwd: directory, encoding: "utf8", shell: process.platform === "win32" },
    ),
  );
  const filename = field(parsed, "filename");
  if (typeof filename !== "string" || filename === "") {
    throw new Error(`pnpm pack did not report a tarball for ${directory}`);
  }
  return filename;
}

async function main(): Promise<void> {
  const options = registryOptionsOrExit(
    process.argv.slice(2),
    "usage: node scripts/check-fresh-install.ts [--summary <file>] [--from-registry <version> [--registry <url>]]",
  );
  const summaryAt = options.rest.indexOf("--summary");
  const summaryFile = summaryAt === -1 ? undefined : options.rest[summaryAt + 1];
  const unknown = options.rest.filter(
    (_, index) => summaryAt === -1 || (index !== summaryAt && index !== summaryAt + 1),
  );
  if (unknown.length > 0 || (summaryAt !== -1 && summaryFile === undefined)) {
    process.stderr.write(`unexpected arguments: ${options.rest.join(" ")}\n`);
    process.exit(1);
  }
  const fromRegistry = options.version;
  const registry = options.registry ?? NPM_REGISTRY;
  const core = path.join(root, "packages", "hardhat-kms");
  const hardhat = resolvedVersion(core, "hardhat");
  if (fromRegistry === undefined) {
    run(["run", "build"]);
  }
  const work = realpathSync(mkdtempSync(path.join(tmpdir(), "hardhat-kms-fresh-install-")));
  const problems: string[] = [];
  const notes: string[] = [];
  const rows: string[] = [];
  try {
    const tarballs = path.join(work, "tarballs");
    mkdirSync(tarballs);
    const spec = (directory: string): string =>
      fromRegistry ?? `file:${pack(path.join(root, "packages", directory), tarballs)}`;
    const coreSpec = spec("hardhat-kms");
    const installs: {
      label: string;
      provider: string;
      manager: Manager;
      tree: Map<string, string>;
    }[] = [];
    for (const provider of PROVIDERS) {
      const providerSpec = spec(provider.directory);
      for (const manager of MANAGERS) {
        const label = `${provider.name} with ${manager}`;
        const directory = path.join(work, `${provider.directory}-${manager}`);
        mkdirSync(directory);
        // Hardhat is the peer every user has, at the version this repository tests.
        writeFileSync(
          path.join(directory, "package.json"),
          `${JSON.stringify(
            {
              name: `fresh-install-${provider.directory}-${manager}`,
              private: true,
              type: "module",
              dependencies: { hardhat, "hardhat-kms": coreSpec, [provider.name]: providerSpec },
            },
            null,
            2,
          )}\n`,
        );
        const started = Date.now();
        // A new cache directory for each install: nothing an earlier install fetched is reused.
        install(
          manager,
          directory,
          path.join(work, `cache-${provider.directory}-${manager}`),
          options.registry,
        );
        process.stdout.write(`== ${label}: ${Math.round((Date.now() - started) / 1000)} s\n`);
        if (fromRegistry !== undefined) {
          assertInstalledVersion(directory, fromRegistry);
        }
        const tree = productionTree(directory, ["hardhat-kms", provider.name]);
        // The four packages are this repository's; check-registry-release.ts checks them.
        for (const key of tree.keys()) {
          if (PACKAGES.includes(nameOf(key))) {
            tree.delete(key);
          }
        }
        installs.push({ label, provider: provider.name, manager, tree });
      }
    }
    const deprecated = await registryDeprecations(
      new Set(installs.flatMap(({ tree }) => [...tree.keys()])),
      async (name) => await fetchFromRegistry(registry, name),
    );
    for (const { label, provider, manager, tree } of installs) {
      const report = classifyFresh(label, tree, deprecated);
      problems.push(...report.problems);
      notes.push(...report.notes);
      const found = [...tree.keys()].filter((key) => deprecated.has(key));
      rows.push(
        `| ${provider} | ${manager} | ${tree.size} | ${found.length === 0 ? "none" : found.map((key) => `\`${key}\`${ALLOWED.some((entry) => entry.name === nameOf(key)) ? " (allowed)" : ""}`).join(", ")} |`,
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const table = [
    "## Fresh installs: deprecated packages",
    "",
    `Node ${process.version}, npm ${toolVersion("npm")}, pnpm ${toolVersion("pnpm")}, empty caches, ${fromRegistry === undefined ? "packed from the workspace" : `version ${fromRegistry} from the registry`}; deprecation read from ${registry}.`,
    "",
    "| Package | Package manager | Packages in the production tree | Deprecated |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
  process.stdout.write(`\n${table}\n`);
  if (summaryFile !== undefined) {
    appendFileSync(summaryFile, table);
  }
  for (const note of notes) {
    process.stdout.write(`${note}\n`);
  }
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    "fresh install check passed: no unlisted deprecated package in a fresh install's production tree\n",
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
