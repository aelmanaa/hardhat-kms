import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import semver from "semver";

import { kmsError } from "../errors.ts";
import type { ProviderSdk } from "./types.ts";

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
 * The package is resolved from the project root, not from this plugin's own location, so it works
 * with npm, pnpm and Yarn, where the plugin may not see the project's dependencies.
 *
 * @param sdk - The package and the supported version range.
 * @param projectRoot - The Hardhat project root, which holds the project's `package.json`.
 * @param provider - The provider id, for error messages.
 * @returns The package's module namespace.
 * @throws A `HardhatPluginError` with the install command if the package is missing or outside
 * the supported range.
 */
export async function loadSdk(
  sdk: ProviderSdk,
  projectRoot: string,
  provider: string,
): Promise<unknown> {
  const require = createRequire(path.join(projectRoot, "package.json"));
  let entry: string;
  try {
    entry = require.resolve(sdk.packageName);
  } catch {
    throw kmsError(
      `${sdk.packageName} is not installed in this project. Install it with: ${installCommand(sdk)}`,
      { provider, operation: "load SDK" },
    );
  }
  const version = installedVersion(entry, sdk.packageName);
  if (version === undefined || !semver.satisfies(version, sdk.range)) {
    throw kmsError(
      `found ${sdk.packageName} ${version ?? "with an unknown version"}, but this plugin supports ${sdk.range}. Install a supported version with: ${installCommand(sdk)}`,
      { provider, operation: "load SDK" },
    );
  }
  return (await import(pathToFileURL(entry).href)) as unknown;
}
