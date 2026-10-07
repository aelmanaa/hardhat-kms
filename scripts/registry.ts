// Registry mode of the package checks: `--from-registry <version>` makes scripts/check-packages.ts,
// scripts/consumer-typecheck.ts and scripts/test-peer-installs.ts install the four published
// packages at that exact version instead of the tarballs they pack, and
// scripts/check-registry-release.ts runs only in this mode. `--registry <url>` points every npm
// call at another registry, for a rehearsal against a local one before a release.
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
 * Reads `--from-registry <version>` and `--registry <url>`, in both the `--option value` and the
 * `--option=value` spellings, out of a script's arguments.
 *
 * @param argv - The arguments after the script's path.
 * @param registryNeedsVersion - Whether `--registry` without `--from-registry` is an error; false
 * for a script that takes the version as a positional argument.
 * @returns The options and the remaining arguments, in their order.
 * @throws When an option has no value, the version is not exact, or `--registry` comes without
 * `--from-registry`.
 */
export function parseRegistryOptions(
  argv: readonly string[],
  registryNeedsVersion: boolean = true,
): RegistryOptions {
  const options: RegistryOptions = { rest: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }
    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    if (name !== "--from-registry" && name !== "--registry") {
      options.rest.push(argument);
      continue;
    }
    const value = equals === -1 ? argv[index + 1] : argument.slice(equals + 1);
    if (value === undefined || value === "" || (equals === -1 && value.startsWith("--"))) {
      throw new Error(`${name} needs a value`);
    }
    if (name === "--from-registry") {
      options.version = exactVersion(value);
    } else {
      options.registry = value;
    }
    if (equals === -1) {
      index += 1;
    }
  }
  if (registryNeedsVersion && options.registry !== undefined && options.version === undefined) {
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
 * The `.yarnrc.yml` of a Yarn 4 test project. Yarn 4.15 and later skip versions published less
 * than a day ago (`npmMinimalAgeGate`), so on the day of a release every registry-mode install
 * would stop with `YN0016`. Registry mode therefore adds the line the install page tells users to
 * add on release day, `npmPreapprovedPackages`, for the four packages only: every other package
 * stays under the age gate. Tarball mode installs the packages from `file:` paths, which the age
 * gate does not apply to, and gets no such line.
 *
 * @param registryMode - Whether the project installs the packages from a registry.
 * @returns The file's text.
 */
export function yarnBerrySettings(registryMode: boolean): string {
  const lines = [
    "nodeLinker: node-modules",
    "enableScripts: false",
    "enableTelemetry: false",
    "enableHardenedMode: false",
  ];
  if (registryMode) {
    lines.push('npmPreapprovedPackages: ["hardhat-kms", "@hardhat-kms/*"]');
  }
  return `${lines.join("\n")}\n`;
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
