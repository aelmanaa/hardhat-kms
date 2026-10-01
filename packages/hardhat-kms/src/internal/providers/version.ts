import { createRequire } from "node:module";

import { PLUGIN_ID } from "../constants.ts";
import { ERRORS } from "../error-catalog.ts";
import { catalogError, type ErrorDetails, fillTemplate, internalError } from "../errors.ts";

const require = createRequire(import.meta.url);

/**
 * Reads the `version` field of an installed package's package.json.
 *
 * @param packageName - The package, resolved from this module.
 * @returns The version.
 */
function installedVersion(packageName: string): string {
  const manifest: unknown = require(`${packageName}/package.json`);
  const version: unknown =
    typeof manifest === "object" && manifest !== null
      ? Reflect.get(manifest, "version")
      : undefined;
  if (typeof version !== "string" || version === "") {
    throw internalError(ERRORS.noPackageVersion, { packageName });
  }
  return version;
}

/** Drops build metadata (`+…`), which does not make a different release. */
function release(version: string): string {
  return version.split("+")[0] ?? version;
}

/** The `major.minor.patch` numbers of a version, or `undefined` if it does not start with them. */
function numericParts(version: string): number[] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(version);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Picks the version to recommend: the newer by `major.minor.patch`, and on a tie the one without
 * a prerelease tag.
 *
 * @returns The version, or `undefined` if either is not a plain numeric version.
 */
function newer(a: string, b: string): string | undefined {
  const [left, right] = [numericParts(a), numericParts(b)];
  if (left === undefined || right === undefined) {
    return undefined;
  }
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference > 0 ? a : b;
    }
  }
  return a.includes("-") ? b : a;
}

/** A version mismatch, as the values of its catalogue entry. */
type Mismatch =
  | { target: undefined; params: { package: string; version: string; core: string } }
  | { target: string; params: { package: string; version: string; core: string; target: string } };

function mismatchOf(
  packageName: string,
  version: string,
  coreVersion: string,
): Mismatch | undefined {
  const [provider, core] = [release(version), release(coreVersion)];
  if (provider === core) {
    return undefined;
  }
  const params = { package: packageName, version: provider, core };
  const target = newer(provider, core);
  return target === undefined ? { target, params } : { target, params: { ...params, target } };
}

/**
 * Explains a version mismatch between a first-party provider package and hardhat-kms.
 *
 * @returns The message, or `undefined` when the versions match.
 */
export function versionMismatch(
  packageName: string,
  version: string,
  coreVersion: string,
): string | undefined {
  const mismatch = mismatchOf(packageName, version, coreVersion);
  if (mismatch === undefined) {
    return undefined;
  }
  return mismatch.target === undefined
    ? fillTemplate(ERRORS.versionMismatchNoTarget.template, mismatch.params)
    : fillTemplate(ERRORS.versionMismatch.template, mismatch.params);
}

/**
 * Checks that a first-party provider package, such as hardhat-kms-aws, is the same version as the
 * installed hardhat-kms. They are released together, and the `kms` hook may change between
 * versions before 1.0. npm refuses such an install, but pnpm and Yarn only warn. Third-party
 * providers have their own versions and should not call this.
 *
 * @param packageName - The provider package.
 * @param version - The provider package's version.
 * @param details - Context for the error, such as the provider, operation and key.
 * @throws A `HardhatPluginError` that names both versions and the install command.
 */
export function checkProviderVersion(
  packageName: string,
  version: string,
  details: ErrorDetails = {},
): void {
  const mismatch = mismatchOf(packageName, version, installedVersion(PLUGIN_ID));
  if (mismatch !== undefined) {
    throw mismatch.target === undefined
      ? catalogError(ERRORS.versionMismatchNoTarget, mismatch.params, details)
      : catalogError(ERRORS.versionMismatch, mismatch.params, details);
  }
}
