// Registry mode of the package checks: `--from-registry <version>` makes scripts/check-packages.ts,
// scripts/consumer-typecheck.ts and scripts/test-peer-installs.ts install the four published
// packages at that exact version instead of the tarballs they pack, and
// scripts/check-registry-release.ts runs only in this mode. `--registry <url>` points every npm
// call at another registry, for a rehearsal against a local one before the first release.
import { resolvedVersion } from "./temporary-install.ts";

/** The published packages, in the order the scripts install and report them. */
export const PACKAGES: readonly string[] = [
  "hardhat-kms",
  "@hardhat-kms/aws",
  "@hardhat-kms/gcp",
  "@hardhat-kms/azure",
];

/** An exact `major.minor.patch` version, with an optional prerelease such as `1.0.0-beta.1`. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** What `--from-registry` and `--registry` ask for, and the arguments left for the script. */
export interface RegistryOptions {
  /** The exact version to install from the registry; absent in tarball mode. */
  version?: string;
  /** The registry URL to pass to npm; absent for the default registry. */
  registry?: string;
  /** The arguments that are not the two options and their values. */
  rest: string[];
}

/**
 * Reads `--from-registry <version>` and `--registry <url>` out of a script's arguments.
 *
 * @param argv - The arguments after the script's path.
 * @returns The options and the remaining arguments, in their order.
 * @throws When an option has no value, the version is not exact, or `--registry` comes without
 * `--from-registry`.
 */
export function parseRegistryOptions(argv: readonly string[]): RegistryOptions {
  const options: RegistryOptions = { rest: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--from-registry" || argument === "--registry") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} needs a value`);
      }
      if (argument === "--from-registry") {
        options.version = exactVersion(value);
      } else {
        options.registry = value;
      }
      index += 1;
    } else if (argument !== undefined) {
      options.rest.push(argument);
    }
  }
  if (options.registry !== undefined && options.version === undefined) {
    throw new Error("--registry applies to registry mode only; add --from-registry <version>");
  }
  return options;
}

/**
 * {@link parseRegistryOptions} for a script's entry point: prints the problem and the usage line
 * and exits with 1 instead of throwing.
 *
 * @param argv - The arguments after the script's path.
 * @param usage - The script's usage line.
 */
export function registryOptionsOrExit(argv: readonly string[], usage: string): RegistryOptions {
  let options: RegistryOptions;
  try {
    options = parseRegistryOptions(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage}\n`);
    process.exit(1);
  }
  return options;
}

/**
 * Checks that a version is exact, so that an install resolves to one version and the check after
 * it can compare.
 *
 * @param version - What the caller passed.
 * @returns The same version.
 */
export function exactVersion(version: string): string {
  if (!EXACT_VERSION.test(version)) {
    throw new Error(`${version} is not an exact version; --from-registry needs one, such as 1.0.0`);
  }
  return version;
}

/**
 * The install specs of the four packages at one version.
 *
 * @param version - An exact version.
 * @returns `hardhat-kms@<version>`, `@hardhat-kms/aws@<version>`, and so on.
 */
export function registrySpecs(version: string): string[] {
  return PACKAGES.map((name) => `${name}@${exactVersion(version)}`);
}

/**
 * The npm arguments that select the registry.
 *
 * @param registry - The registry URL, or undefined for npm's default.
 * @returns `--registry <url>`, or nothing.
 */
export function registryArguments(registry: string | undefined): string[] {
  return registry === undefined ? [] : ["--registry", registry];
}

/**
 * Checks, after an install, that the project resolves `hardhat-kms` at the requested version:
 * what `npm view` and a lockfile say is not what a project loads.
 *
 * @param directory - The installed project.
 * @param version - The version `--from-registry` asked for.
 * @throws When the project resolves another version, with both versions in the message.
 */
export function assertInstalledVersion(directory: string, version: string): void {
  const installed = resolvedVersion(directory, "hardhat-kms");
  if (installed !== version) {
    throw new Error(
      `${directory} resolves hardhat-kms ${installed}; --from-registry asked for ${version}`,
    );
  }
}
