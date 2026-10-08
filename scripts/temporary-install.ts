// Helpers for scripts that install other dependency versions for a test run and put the lockfile
// versions back afterwards: scripts/test-sdk-floors.ts and scripts/test-hardhat-versions.ts.
// scripts/test-peer-installs.ts uses the read and pnpm helpers only: it installs into scratch
// projects outside the workspace, so it has nothing to restore.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMap, isScalar, parseDocument } from "yaml";

export const root: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
// .cmd files need a shell on Windows (CVE-2024-27980 hardening in child_process).
const shell = process.platform === "win32";
/** Set when Ctrl-C or SIGTERM stops the script or the command it runs. */
let interrupted = false;

/** Whether Ctrl-C or SIGTERM stopped the script or the command it ran. */
export function wasInterrupted(): boolean {
  return interrupted;
}

/**
 * Lets Node deliver a pending SIGINT or SIGTERM to the listeners below. They cannot run while a
 * command runs synchronously, and pnpm may exit with status 1 when interrupted.
 */
export async function deliverSignals(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

/** Runs pnpm in the repository root, and records an interruption if the command was stopped. */
export function run(args: string[]): void {
  try {
    execFileSync(pnpm, args, { cwd: root, stdio: "inherit", shell });
  } catch (error) {
    // Ctrl-C reaches the child too. It ends by the signal or exits with 128 + its number.
    const signal: unknown = Reflect.get(Object(error), "signal");
    const status: unknown = Reflect.get(Object(error), "status");
    if (signal === "SIGINT" || signal === "SIGTERM" || status === 130 || status === 143) {
      interrupted = true;
    }
    throw error;
  }
}

/** Runs pnpm in the repository root and returns its standard output. */
export function output(args: string[]): string {
  return execFileSync(pnpm, args, { cwd: root, shell, encoding: "utf8" });
}

/** Reads a JSON file that must hold an object. */
export function readJson(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${file} is not a JSON object`);
  }
  return { ...parsed };
}

/** The string-valued entries of an object, such as a manifest's dependencies. */
export function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/**
 * The folder of a dependency that a package resolves.
 *
 * It looks for node_modules/<dependency> in the package's folder and each parent, as Node does
 * for a bare specifier, and checks the disk on every call. require.resolve would not do: Node
 * caches resolutions and symlink targets for the life of the process, so after a second install
 * in the same run it would still return the first version's folder.
 */
export function installedDirectory(directory: string, dependency: string): string {
  for (let folder = path.resolve(directory); ; folder = path.dirname(folder)) {
    const installed = path.join(folder, "node_modules", ...dependency.split("/"));
    if (existsSync(path.join(installed, "package.json"))) {
      return installed;
    }
    if (path.dirname(folder) === folder) {
      throw new Error(`${dependency} is not installed for ${directory}`);
    }
  }
}

/** The version of a dependency that a package resolves, read from the installed package.json. */
export function resolvedVersion(directory: string, dependency: string): string {
  return String(
    readJson(path.join(installedDirectory(directory, dependency), "package.json")).version,
  );
}

/**
 * Runs `body`, then writes `files` back as they were before it ran and reinstalls the lockfile
 * versions. On Ctrl-C or SIGTERM the running pnpm command ends, `run` throws, the files are
 * restored and the script exits with 130 without reinstalling.
 *
 * @param files - Every file the body may rewrite: manifests, pnpm-workspace.yaml, the lockfile.
 * @param body - The installs and test runs. It returns false when a test failed.
 * @returns What `body` returned.
 */
export async function withRestoredFiles(
  files: string[],
  body: () => Promise<boolean>,
): Promise<boolean> {
  const originals = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));
  // Without these listeners Node would exit at once and leave the other versions installed.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      interrupted = true;
    });
  }
  try {
    return await body();
  } finally {
    await deliverSignals();
    for (const [file, content] of originals) {
      writeFileSync(file, content);
    }
    const reinstall = "run `pnpm install --frozen-lockfile` to reinstall the lockfile versions";
    if (interrupted) {
      process.stderr.write(`\nInterrupted. The files are restored; ${reinstall}.\n`);
      // Exit here: the error that the interruption raised would otherwise end the script with 1.
      process.exit(130);
    } else {
      try {
        run(["install", "--frozen-lockfile", "--ignore-scripts"]);
      } catch {
        process.stderr.write(`\nThe files are restored, but reinstalling failed: ${reinstall}.\n`);
      }
    }
  }
}

/**
 * The package an override key forces: `qs` for `qs`, `"typed-rest-client>qs"` and `qs@<6.16`, and
 * `@scope/name` for `parent>@scope/name@^1`.
 */
export function overrideTarget(key: string): string {
  const target = key.slice(key.lastIndexOf(">") + 1);
  const range = target.indexOf("@", 1);
  return range === -1 ? target : target.slice(0, range);
}

/**
 * The text of pnpm-workspace.yaml with `entries` set in its `overrides`, keeping the other
 * overrides, the other settings and the comments the file has.
 *
 * @param text - The file's current text.
 * @param entries - Package names and the versions to force.
 * @param replaceable - Names whose own plain override (`name: version`) may be replaced, such as
 *   overrides an earlier call added.
 * @returns The new text.
 * @throws When an override already in the file forces an entry's package, in any form (`name`,
 *   `parent>name`, `name@range`): it would win for some or all copies, so the test would not run
 *   the version it asks for, or the file's override would be lost.
 */
export function withOverrides(
  text: string,
  entries: Record<string, string>,
  replaceable: readonly string[] = [],
): string {
  const document = parseDocument(text);
  const existing = document.get("overrides");
  if (existing !== undefined && !isMap(existing)) {
    throw new Error("pnpm-workspace.yaml has an overrides entry that is not a map");
  }
  const keys = (existing?.items ?? []).map((pair) =>
    String(isScalar(pair.key) ? pair.key.value : pair.key),
  );
  for (const [name, version] of Object.entries(entries)) {
    for (const key of keys) {
      if (overrideTarget(key) === name && !(key === name && replaceable.includes(name))) {
        throw new Error(`pnpm-workspace.yaml already overrides ${name} (${key})`);
      }
    }
    document.setIn(["overrides", name], version);
  }
  return document.toString();
}
