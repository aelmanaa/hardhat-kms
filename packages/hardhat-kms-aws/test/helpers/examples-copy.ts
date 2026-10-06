// Copies the projects in examples/ out of the workspace, as a user copies one, with the plugin
// packages at an exact version. The examples test runs the copies with npm against a registry
// (registry mode), where the workspace runs them with pnpm against the workspace builds.
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The two dependencies every example takes from the registry. */
export const EXAMPLE_DEPENDENCIES: readonly string[] = ["hardhat-kms", "@hardhat-kms/aws"];

/** Directories the copy does not take: installs and build output of the workspace run. */
const SKIPPED = new Set(["node_modules", "artifacts", "cache", "deployments"]);

/**
 * The manifest of an example with the plugin packages at one exact version, as a user's project
 * has them after `npm install --save-dev hardhat-kms@<version> @hardhat-kms/aws@<version>`.
 *
 * @param manifest - The example's package.json, parsed.
 * @param version - The exact version to write.
 * @returns A new manifest; the fields keep their order.
 * @throws When the manifest does not list both packages under `devDependencies`.
 */
export function withPluginVersion(
  manifest: Record<string, unknown>,
  version: string,
): Record<string, unknown> {
  const devDependencies = manifest.devDependencies;
  if (typeof devDependencies !== "object" || devDependencies === null) {
    throw new Error(`${String(manifest.name)} has no devDependencies`);
  }
  const missing = EXAMPLE_DEPENDENCIES.filter((name) => !Object.hasOwn(devDependencies, name));
  if (missing.length > 0) {
    throw new Error(
      `${String(manifest.name)} does not list ${missing.join(", ")} under devDependencies`,
    );
  }
  return {
    ...manifest,
    devDependencies: Object.fromEntries(
      Object.entries(devDependencies).map(([name, range]) => [
        name,
        EXAMPLE_DEPENDENCIES.includes(name) ? version : range,
      ]),
    ),
  };
}

/**
 * Copies every example directory to `destination`, without installs and build output, and writes
 * the plugin packages at `version` into each copy's package.json.
 *
 * @param source - The examples directory of the repository.
 * @param destination - An existing, empty directory.
 * @param version - The exact version of hardhat-kms and @hardhat-kms/aws to write.
 * @returns The names of the copied examples, sorted.
 */
export function copyExamples(source: string, destination: string, version: string): string[] {
  const examples = readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
  for (const example of examples) {
    const target = path.join(destination, example);
    cpSync(path.join(source, example), target, {
      recursive: true,
      filter: (file) => !SKIPPED.has(path.basename(file)),
    });
    const manifestFile = path.join(target, "package.json");
    const manifest: unknown = JSON.parse(readFileSync(manifestFile, "utf8"));
    if (typeof manifest !== "object" || manifest === null) {
      throw new Error(`${manifestFile} is not a JSON object`);
    }
    writeFileSync(
      manifestFile,
      `${JSON.stringify(withPluginVersion({ ...manifest }, version), null, 2)}\n`,
    );
  }
  return examples;
}
