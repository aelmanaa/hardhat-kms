// Packs workspace packages for the scripts that check or install the tarballs. Every run packs
// into its own directory: `pnpm pack` names a tarball after the package name and version, so two
// runs that pack into the system temp directory write and delete the same files.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
// .cmd files need a shell on Windows (CVE-2024-27980 hardening in child_process).
const shell = process.platform === "win32";

const PREFIX = "hardhat-kms-pack-";

/**
 * Runs `use` with a new, empty directory and removes the directory afterwards, also when `use`
 * throws. `use` must finish its work before it returns: the directory does not outlive the call.
 *
 * @param use - Receives the directory's path.
 * @returns What `use` returns.
 */
export function withPackDirectory<T>(use: (directory: string) => T): T {
  const directory = mkdtempSync(path.join(tmpdir(), PREFIX));
  try {
    return use(directory);
  } finally {
    removePackDirectory(directory);
  }
}

/**
 * Removes a directory that {@link withPackDirectory} created. The clean-up runs with
 * `recursive: true`, so it refuses any other path: the temp directory itself, or a directory
 * outside it, must never be removed by a wrong edit to this file.
 *
 * @param directory - The directory to remove.
 */
export function removePackDirectory(directory: string): void {
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== path.resolve(tmpdir()) ||
    !path.basename(resolved).startsWith(PREFIX)
  ) {
    throw new Error(
      `refusing to remove ${directory}: not a ${PREFIX}* directory under ${tmpdir()}`,
    );
  }
  rmSync(resolved, { recursive: true, force: true });
}

/**
 * Packs a package as pnpm publishes it (workspace: and catalog: ranges replaced).
 *
 * @param packageDirectory - The package to pack.
 * @param destination - The directory the tarball goes to, from {@link withPackDirectory}.
 * @returns The tarball path.
 */
export function pack(packageDirectory: string, destination: string): string {
  const output: unknown = JSON.parse(
    execFileSync(pnpm, ["pack", "--json", "--pack-destination", destination], {
      cwd: packageDirectory,
      shell,
    }).toString(),
  );
  if (
    typeof output === "object" &&
    output !== null &&
    "filename" in output &&
    typeof output.filename === "string" &&
    output.filename !== ""
  ) {
    return output.filename;
  }
  throw new Error(`pnpm pack did not report a tarball for ${packageDirectory}`);
}
