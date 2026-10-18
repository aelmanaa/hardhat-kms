// The published packages: every packages/*/package.json without `"private": true`, the core first,
// then the others by directory name. The one list the release scripts read; release-stage.yml and
// promote.yml print it with the command below instead of carrying a list of their own. It imports
// only node: modules, so the publish jobs run it from a sparse checkout with no dependencies.
//
// Usage: node scripts/release-packages.ts [--directories] [--commit SHA]
//   Prints one package name per line, or with --directories its directory under packages/. With
//   --commit it reads the packages of that commit through `git`, not the files on disk, so a job
//   on main can list the packages of an older tag.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The npm name of the core package; it is first in the list, since the providers pin it. */
export const CORE = "hardhat-kms";
/**
 * The names this repository may publish: the core, or a package of the `@hardhat-kms` scope.
 * promote.yml's dist-tag move checks each name against the same pattern.
 */
export const PUBLISHABLE_NAME: RegExp = /^(hardhat-kms|@hardhat-kms\/[a-z0-9-]+)$/;

/** A published package and its directory under packages/. */
export interface ReleasePackage {
  name: string;
  directory: string;
}

/** One manifest as read from packages/<directory>/package.json. */
export interface WorkspaceManifest {
  directory: string;
  /** The parsed package.json. */
  manifest: unknown;
}

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

/** Orders the core first, then the others by directory name. */
function releaseOrder(a: ReleasePackage, b: ReleasePackage): number {
  if (a.name === CORE || b.name === CORE) {
    return a.name === CORE ? -1 : 1;
  }
  return a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0;
}

/**
 * Picks the published packages out of the workspace manifests and orders them.
 *
 * @param manifests - Each packages/<directory>/package.json, parsed.
 * @returns The packages without `"private": true`: the core first, then by directory name.
 * @throws When a published manifest has no name or a name outside the project, two share a name,
 *   or the core is not among them.
 */
export function releasePackagesFrom(manifests: readonly WorkspaceManifest[]): ReleasePackage[] {
  const packages: ReleasePackage[] = [];
  for (const { directory, manifest } of manifests) {
    if (field(manifest, "private") === true) {
      continue;
    }
    const name = field(manifest, "name");
    if (typeof name !== "string" || name === "") {
      throw new Error(`packages/${directory}/package.json has no name and is not private`);
    }
    if (!PUBLISHABLE_NAME.test(name)) {
      throw new Error(
        `packages/${directory}/package.json is named ${name}; a published package is hardhat-kms or @hardhat-kms/<name>`,
      );
    }
    const twin = packages.find((other) => other.name === name);
    if (twin !== undefined) {
      throw new Error(
        `packages/${twin.directory} and packages/${directory} are both named ${name}`,
      );
    }
    packages.push({ name, directory });
  }
  if (!packages.some((entry) => entry.name === CORE)) {
    throw new Error(`no published package under packages/ is named ${CORE}`);
  }
  return packages.toSorted(releaseOrder);
}

/**
 * Reads the published packages from a checkout.
 *
 * @param root - The repository root.
 * @returns The packages, as {@link releasePackagesFrom} orders them.
 * @throws When a directory under packages/ has no package.json, or as {@link releasePackagesFrom}.
 */
export function readReleasePackages(root: string): ReleasePackage[] {
  const packagesDirectory = path.join(root, "packages");
  const manifests = readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry): WorkspaceManifest => {
      const file = path.join(packagesDirectory, entry.name, "package.json");
      if (!existsSync(file)) {
        throw new Error(`packages/${entry.name} has no package.json`);
      }
      return { directory: entry.name, manifest: JSON.parse(readFileSync(file, "utf8")) };
    });
  return releasePackagesFrom(manifests);
}

/** What a `git` call returned. */
export interface GitResult {
  status: number | null;
  stdout: string;
}

/**
 * Reads the published packages of a commit through `git`, without checking it out.
 *
 * @param commit - The commit, or any name `git` resolves to one.
 * @param git - Runs `git` with the given arguments in the repository.
 * @returns The packages, as {@link releasePackagesFrom} orders them.
 * @throws When `git` cannot list the commit's packages/, or a manifest is missing or not JSON.
 */
export function releasePackagesAt(
  commit: string,
  git: (args: readonly string[]) => GitResult,
): ReleasePackage[] {
  const listed = git(["ls-tree", "-d", "--name-only", `${commit}:packages`]);
  if (listed.status !== 0) {
    throw new Error(`git cannot list packages/ at ${commit}`);
  }
  const manifests = listed.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((directory): WorkspaceManifest => {
      const file = `packages/${directory}/package.json`;
      const shown = git(["show", `${commit}:${file}`]);
      if (shown.status !== 0) {
        throw new Error(`${file} is missing at ${commit}`);
      }
      let manifest: unknown;
      try {
        manifest = JSON.parse(shown.stdout);
      } catch {
        throw new Error(`${file} at ${commit} is not JSON`);
      }
      return { directory, manifest };
    });
  return releasePackagesFrom(manifests);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Runs `git` in a repository, for {@link releasePackagesAt}.
 *
 * @param cwd - The repository; defaults to this checkout.
 * @returns A function that runs `git` with the given arguments there.
 */
export function runGit(cwd: string = root): (args: readonly string[]) => GitResult {
  return (args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout };
  };
}

/** The published packages of this checkout, in release order. */
export const RELEASE_PACKAGES: readonly ReleasePackage[] = readReleasePackages(root);
/** Their npm names, in the order the scripts install, pack, stage and report them. */
export const PACKAGES: readonly string[] = RELEASE_PACKAGES.map((entry) => entry.name);

function main(argv: readonly string[]): void {
  const { values } = parseArgs({
    args: [...argv],
    options: { directories: { type: "boolean" }, commit: { type: "string" } },
    strict: true,
  });
  const packages =
    values.commit === undefined ? RELEASE_PACKAGES : releasePackagesAt(values.commit, runGit());
  for (const entry of packages) {
    process.stdout.write(`${values.directories === true ? entry.directory : entry.name}\n`);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
