// Tests hardhat-kms against the lowest version of each Hardhat library it depends on:
// @nomicfoundation/hardhat-utils, hardhat-errors and hardhat-zod-utils (#587). CI tests the
// lockfile versions, and Dependabot moves the lockfile forward, so without this script the declared
// floors are never installed. hardhat-utils converts the hex and numbers that become signed bytes,
// and hardhat-zod-utils validates a request before it is filled and signed.
//
// A range that accepts several majors, such as `^4.3.0 || ^5.0.0`, has a floor per major (see
// scripts/version-range.ts). The first run installs the first floor of every library; each further
// floor gets a run of its own, with the other libraries at their first floor. A run installs the
// floors into hardhat-kms only, as exact dependencies, so Hardhat and other plugins keep their own
// copies as they would in a user's project. It checks that hardhat-kms resolves each floor, builds,
// typechecks hardhat-kms with its tests, and runs its unit and integration tests, which include the
// differential test against Hardhat's unsigned bytes. The manifest and the lockfile are restored
// afterwards, even on Ctrl-C, and the install is redone from the restored lockfile.
//
// Usage: node scripts/test-library-floors.ts
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  deliverSignals,
  readJson,
  resolvedVersion,
  root,
  run,
  stringRecord,
  wasInterrupted,
  withRestoredFiles,
} from "./temporary-install.ts";
import { floorsOf } from "./version-range.ts";

/** The package whose dependencies are tested. */
const PACKAGE = "hardhat-kms";

/** The Hardhat libraries whose floors matter. */
const LIBRARY = /^@nomicfoundation\/hardhat-(utils|errors|zod-utils)$/;

/** One run: a version of each library. */
type FloorRun = Record<string, string>;

/**
 * The runs for each library's floors: the first floor of every library, then one run per further
 * floor, with the other libraries at their first floor.
 *
 * @param floors - Each library's floors, in order.
 * @returns The runs, first the one with every first floor.
 */
export function floorRuns(floors: Readonly<Record<string, readonly string[]>>): FloorRun[] {
  const first: FloorRun = {};
  for (const [library, versions] of Object.entries(floors)) {
    const version = versions[0];
    if (version === undefined) {
      throw new Error(`${library} has no floor`);
    }
    first[library] = version;
  }
  return [
    first,
    ...Object.entries(floors).flatMap(([library, versions]) =>
      versions.slice(1).map((version) => ({ ...first, [library]: version })),
    ),
  ];
}

function main(): Promise<boolean> {
  const directory = path.join(root, "packages", PACKAGE);
  const manifest = readJson(path.join(directory, "package.json"));
  const floors = Object.fromEntries(
    Object.entries(stringRecord(manifest.dependencies))
      .filter(([library]) => LIBRARY.test(library))
      .map(([library, range]) => {
        try {
          return [library, floorsOf(range)];
        } catch (error) {
          throw new Error(
            `${PACKAGE}: ${library} ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }),
  );
  if (Object.keys(floors).length === 0) {
    throw new Error(
      `${PACKAGE} depends on none of hardhat-utils, hardhat-errors, hardhat-zod-utils`,
    );
  }
  const runs = floorRuns(floors);
  // Everything `pnpm add` may rewrite.
  const restorable = [path.join(root, "pnpm-lock.yaml"), path.join(directory, "package.json")];
  return withRestoredFiles(restorable, async () => {
    let failed = false;
    for (const versions of runs) {
      const label = Object.entries(versions)
        .map(([library, version]) => `${library}@${version}`)
        .join(", ");
      process.stdout.write(`\n== ${PACKAGE}: ${label}\n`);
      run([
        "--fail-if-no-match",
        "--filter",
        PACKAGE,
        "add",
        ...Object.entries(versions).map(([library, version]) => `${library}@${version}`),
        "--save-exact",
        "--ignore-scripts",
      ]);
      for (const [library, version] of Object.entries(versions)) {
        const installed = resolvedVersion(directory, library);
        if (installed !== version) {
          throw new Error(`${PACKAGE} resolves ${library} ${installed}, not ${version}`);
        }
      }
      try {
        // Build after the floors are installed, so the packages compile against them.
        run(["run", "build"]);
        // Typecheck the tests too: they use the libraries' types as well.
        run(["exec", "tsc", "-b", directory]);
        run(["--fail-if-no-match", "--filter", PACKAGE, "run", "test"]);
      } catch (error) {
        await deliverSignals();
        if (wasInterrupted()) {
          throw error;
        }
        failed = true;
        process.stderr.write(
          `\n${PACKAGE} fails with ${label}. Raise the floor to a version that passes, and say why in the changeset.\n`,
        );
      }
    }
    return !failed;
  }).then((passed) => {
    if (passed) {
      process.stdout.write(
        `\nHardhat library floors pass: ${runs
          .map((versions) =>
            Object.entries(versions)
              .map(([library, version]) => `${library}@${version}`)
              .join(", "),
          )
          .join("; ")}\n`,
      );
    }
    return passed;
  });
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (!(await main())) {
    process.exitCode = 1;
  }
}
