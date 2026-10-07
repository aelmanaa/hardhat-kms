// Creates and removes the throwaway Hardhat projects of the CLI integration tests. A project sits in
// its package's `.tmp` directory, not in os.tmpdir(): there Node and Hardhat find `hardhat` and `tsx`
// in the package's node_modules by the normal upward lookup. A project in os.tmpdir() needs a link to
// node_modules, and on the Windows runner (temp dir on C:, checkout on D:) lookups through that
// junction failed: ERR_MODULE_NOT_FOUND for tsx, then HHE22 for hardhat.
//
// The removal refuses any path this module did not create, so a wrong path cannot remove anything
// else. Stop every child that runs in a project, and wait for its exit, before removing it: on
// Windows a running process locks its working directory, and removing it fails with EBUSY (#326).
import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The projects this module created and has not removed yet. */
const created = new Set<string>();

/**
 * Creates an empty project directory under a package's `.tmp` directory.
 *
 * @param prefix - The start of the directory's name, such as `"tasks-cli-"`.
 * @param packageDirectory - The package whose node_modules the project resolves from; hardhat-kms
 *   unless another package's test passes its own directory.
 * @returns The project's absolute path.
 */
export function createTempProject(prefix: string, packageDirectory: string = repo): string {
  if (!/^[a-z][a-z-]*-$/.test(prefix)) {
    throw new Error(`a project prefix is lowercase words joined and ended by "-": ${prefix}`);
  }
  const root = path.join(packageDirectory, ".tmp");
  mkdirSync(root, { recursive: true });
  const project = mkdtempSync(path.join(root, prefix));
  created.add(project);
  return project;
}

/**
 * Removes a project that {@link createTempProject} created. Windows can still hold a file for a
 * moment after the process that used it exits, and an antivirus scan can open one too, so the
 * removal retries a busy directory for up to two seconds.
 *
 * @param project - The path that {@link createTempProject} returned.
 */
export async function removeTempProject(project: string): Promise<void> {
  if (!created.has(project)) {
    throw new Error(`refusing to remove ${project}: createTempProject did not create it`);
  }
  await rm(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  created.delete(project);
}
