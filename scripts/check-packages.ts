// Checks every publishable package in packages/ the way npm users will get it: publint on the
// package contents, and arethetypeswrong on the packed tarball (ESM only). Run after a build.
// It also fails when a package takes TypeScript from the typescript6 catalog.
//
// Usage: node scripts/check-packages.ts
//        node scripts/check-packages.ts --from-registry <version> [--registry <url>]
//
// With --from-registry nothing is built or packed here: `npm pack` downloads each package at that
// version from the registry (the tarball `npm install` would get, checked against the registry's
// integrity hash), and publint and attw run on it.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pack, withPackDirectory } from "./pack.ts";
import { PACKAGES, registryArguments, registryOptionsOrExit } from "./registry.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shell = process.platform === "win32";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const bin = (name: string): string =>
  path.join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);

const usage =
  "usage: node scripts/check-packages.ts [--from-registry <version> [--registry <url>]]";
const options = registryOptionsOrExit(process.argv.slice(2), usage);
if (options.rest.length > 0) {
  process.stderr.write(`${usage}\n`);
  process.exit(1);
}

/** publint on a package directory or a tarball, then attw on the tarball. */
function check(cwd: string, publintTarget: string, tarball: string): void {
  execFileSync(bin("publint"), ["--strict", publintTarget], { cwd, stdio: "inherit", shell });
  execFileSync(bin("attw"), [tarball, "--profile", "esm-only"], { cwd, stdio: "inherit", shell });
}

/**
 * Downloads a package at one version with `npm pack`, which checks the tarball against the
 * registry's integrity hash.
 *
 * @returns The tarball's path.
 */
function packFromRegistry(spec: string, version: string, destination: string): string {
  let output: string;
  try {
    output = execFileSync(
      npm,
      [
        "pack",
        spec,
        "--json",
        "--pack-destination",
        destination,
        ...registryArguments(options.registry),
      ],
      { cwd: destination, shell, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    const stderr: unknown = Reflect.get(Object(error), "stderr");
    const reason = String(stderr)
      .split("\n")
      .filter((line) => line.startsWith("npm error") && !line.includes("complete log"))
      .join("\n");
    throw new Error(`npm pack ${spec} failed:\n${reason}`, { cause: error });
  }
  const parsed: unknown = JSON.parse(output);
  const first: unknown = Array.isArray(parsed) ? parsed[0] : undefined;
  const filename: unknown = Reflect.get(Object(first), "filename");
  const packed: unknown = Reflect.get(Object(first), "version");
  if (typeof filename !== "string" || filename === "") {
    throw new Error(`npm pack did not report a tarball for ${spec}`);
  }
  if (packed !== version) {
    throw new Error(
      `npm pack ${spec} gave version ${String(packed)}; --from-registry asked for ${version}`,
    );
  }
  return path.join(destination, filename);
}

if (options.version !== undefined) {
  const version = options.version;
  withPackDirectory((destination) => {
    for (const name of PACKAGES) {
      const spec = `${name}@${version}`;
      process.stdout.write(`\n== ${spec}\n`);
      const tarball = packFromRegistry(spec, version, destination);
      check(destination, tarball, tarball);
    }
  });
  process.stdout.write(`\nchecked ${PACKAGES.length} packages at ${version} from the registry\n`);
} else {
  const packages = readdirSync(path.join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, "packages", entry.name))
    .filter((directory) => {
      const manifest: unknown = JSON.parse(
        readFileSync(path.join(directory, "package.json"), "utf8"),
      );
      return !(
        typeof manifest === "object" &&
        manifest !== null &&
        "private" in manifest &&
        manifest.private === true
      );
    });

  // TypeScript 6 is for tools/api-docs only (decision 0012). A package under packages/ that takes it
  // from the typescript6 catalog would build or typecheck on the wrong compiler.
  const onTypescript6 = readdirSync(path.join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.posix.join("packages", entry.name, "package.json"))
    .filter((file) =>
      readFileSync(path.join(root, file), "utf8").includes('"catalog:typescript6"'),
    );
  if (onTypescript6.length > 0) {
    throw new Error(
      `${onTypescript6.join(", ")}: the typescript6 catalog is for tools/api-docs only; use catalog: (TypeScript 7)`,
    );
  }

  withPackDirectory((destination) => {
    for (const directory of packages) {
      process.stdout.write(`\n== ${path.relative(root, directory)}\n`);
      // Check the tarball pnpm publishes (workspace: and catalog: ranges replaced), not an npm pack.
      check(directory, ".", pack(directory, destination));
    }
  });
}
