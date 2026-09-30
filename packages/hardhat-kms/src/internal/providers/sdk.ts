import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import semver from "semver";

import { kmsDebug } from "../debug.ts";
import { kmsError } from "../errors.ts";
import type { ProviderSdk } from "./types.ts";

const log = kmsDebug("providers:sdk");

/**
 * Finds the installed version of a package from the path of one of its files.
 *
 * @param entry - A file inside the package.
 * @param packageName - The package's name.
 * @returns The version, or `undefined` if no matching `package.json` is found.
 */
function installedVersion(entry: string, packageName: string): string | undefined {
  let directory = path.dirname(entry);
  for (;;) {
    try {
      const manifest: unknown = JSON.parse(
        readFileSync(path.join(directory, "package.json"), "utf8"),
      );
      if (
        typeof manifest === "object" &&
        manifest !== null &&
        "name" in manifest &&
        manifest.name === packageName &&
        "version" in manifest &&
        typeof manifest.version === "string" &&
        manifest.version !== ""
      ) {
        return manifest.version;
      }
    } catch {
      // No package.json here, or not readable: keep walking up.
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

function installCommand(sdk: ProviderSdk): string {
  return `npm install ${sdk.packageName}@"${sdk.range}"`;
}

/**
 * Loads a provider's SDK package from the user's project.
 *
 * The package is resolved from the project root, not from this plugin's own location: under pnpm
 * and Yarn PnP the plugin cannot see the project's dependencies.
 *
 * @param sdk - The package and the supported version range.
 * @param projectRoot - The Hardhat project root, which holds the project's `package.json`.
 * @param provider - The provider id, for error messages.
 * @returns The package's module namespace.
 * @throws A `HardhatPluginError` with the install command if the package is missing, has no
 * readable version, or is outside the supported range.
 */
export async function loadSdk(
  sdk: ProviderSdk,
  projectRoot: string,
  provider: string,
): Promise<unknown> {
  const context = { provider, operation: "load SDK" };
  const require = createRequire(path.join(projectRoot, "package.json"));
  let entry: string;
  try {
    entry = require.resolve(sdk.packageName);
  } catch (error) {
    const code = errorCode(error);
    throw kmsError(
      code === "MODULE_NOT_FOUND"
        ? `${sdk.packageName} is not installed in this project. Install it with: ${installCommand(sdk)}`
        : `${sdk.packageName} is installed but cannot be loaded (${code ?? "unknown error"}). This plugin loads its CommonJS entry point; reinstall a supported version with: ${installCommand(sdk)}`,
      context,
    );
  }
  if (!isInsideProject(entry, projectRoot)) {
    throw kmsError(
      `${sdk.packageName} was found outside this project (${entry}), for example through NODE_PATH or a global folder. Install it in the project with: ${installCommand(sdk)}`,
      context,
    );
  }
  const version = installedVersion(entry, sdk.packageName);
  if (version === undefined) {
    throw kmsError(
      `found ${sdk.packageName} with an unknown version. Reinstall a supported version with: ${installCommand(sdk)}`,
      context,
    );
  }
  if (!semver.satisfies(version, sdk.range)) {
    const reason =
      semver.prerelease(version) === null ? "" : " Prerelease versions are not supported.";
    throw kmsError(
      `found ${sdk.packageName} ${version}, but this plugin supports ${sdk.range}.${reason} Install a supported version with: ${installCommand(sdk)}`,
      context,
    );
  }
  log(
    "loading %s %s from %s",
    sdk.packageName,
    version,
    path.relative(realPath(projectRoot), entry),
  );
  return (await import(pathToFileURL(entry).href)) as unknown;
}

function realPath(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

/**
 * Checks that a resolved file sits in a `node_modules` folder of the project root or one of its
 * ancestors (workspaces hoist packages to the monorepo root). Node also searches `NODE_PATH` and
 * global folders; packages found there are not the project's. Under Yarn Plug'n'Play there is no
 * `node_modules`, and the check is skipped.
 *
 * @param entry - The resolved file.
 * @param projectRoot - The project root.
 * @returns Whether the file belongs to the project.
 */
function isInsideProject(entry: string, projectRoot: string): boolean {
  if (process.versions.pnp !== undefined) {
    return true;
  }
  const marker = `${path.sep}node_modules${path.sep}`;
  const index = entry.indexOf(marker);
  if (index === -1) {
    return false;
  }
  const owner = realPath(entry.slice(0, index));
  // Node resolves to real paths, so compare against the root's real path (it may be a symlink).
  const root = realPath(projectRoot);
  return root === owner || root.startsWith(owner + path.sep);
}
