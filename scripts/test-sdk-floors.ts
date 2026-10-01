// Tests each provider package against the lowest version of its cloud SDK that its range allows.
// CI tests the lockfile version everywhere else; once Dependabot moves the lockfile forward, this
// is the only check that the declared floor still works.
//
// For each package in packages/ whose dependencies include a cloud SDK, it installs the floor of
// each SDK range (`^3.1143.0` gives 3.1143.0), checks that this version is the one the package
// resolves, typechecks the package against it and runs the package's tests. package.json files,
// pnpm-workspace.yaml and the lockfile are restored afterwards, even on Ctrl-C, and the install is
// redone from the restored lockfile.
//
// Usage: node scripts/test-sdk-floors.ts
import { readdirSync } from "node:fs";
import path from "node:path";

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

/** Package names of cloud SDKs: the dependencies whose floor matters. */
const CLOUD_SDK = /^@(aws-sdk|google-cloud|azure)\//;

interface Floor {
  packageName: string;
  directory: string;
  sdk: string;
  version: string;
}

/** Finds the cloud SDK floors of every package. Only caret ranges are allowed for them. */
function floors(): Floor[] {
  const packagesDirectory = path.join(root, "packages");
  return readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const directory = path.join(packagesDirectory, entry.name);
      const manifest = readJson(path.join(directory, "package.json"));
      const packageName = String(manifest.name);
      return Object.entries(stringRecord(manifest.dependencies))
        .filter(([sdk]) => CLOUD_SDK.test(sdk))
        .map(([sdk, range]) => {
          const match = /^\^(\d+\.\d+\.\d+)$/.exec(range);
          if (match?.[1] === undefined) {
            throw new Error(
              `${packageName}: ${sdk} must use a caret range on a tested version, such as ^1.2.3 (got ${range})`,
            );
          }
          return { packageName, directory, sdk, version: match[1] };
        });
    });
}

const found = floors();
if (found.length === 0) {
  process.stdout.write("No package depends on a cloud SDK.\n");
  process.exit(0);
}

// Everything `pnpm add` may rewrite. pnpm-workspace.yaml gets a minimumReleaseAgeExclude entry
// when a floor is younger than the release-age policy allows.
const restorable = [
  path.join(root, "pnpm-lock.yaml"),
  path.join(root, "pnpm-workspace.yaml"),
  ...new Set(found.map((floor) => path.join(floor.directory, "package.json"))),
];

const passed = await withRestoredFiles(restorable, async () => {
  let failed = false;
  for (const floor of found) {
    process.stdout.write(`\n== ${floor.packageName}: ${floor.sdk}@${floor.version}\n`);
    run([
      "--filter",
      floor.packageName,
      "add",
      `${floor.sdk}@${floor.version}`,
      "--save-exact",
      "--ignore-scripts",
    ]);
    const installed = resolvedVersion(floor.directory, floor.sdk);
    if (installed !== floor.version) {
      throw new Error(
        `${floor.packageName} resolves ${floor.sdk} ${installed}, not ${floor.version}`,
      );
    }
  }
  // Build after the floors are installed, so the packages compile against them.
  run(["run", "build"]);
  for (const floor of found) {
    // Typecheck the tests too: they use the SDK's types as well.
    run(["exec", "tsc", "-b", floor.directory]);
  }
  for (const packageName of new Set(found.map((floor) => floor.packageName))) {
    try {
      run(["--filter", packageName, "run", "test"]);
    } catch (error) {
      await deliverSignals();
      if (wasInterrupted()) {
        throw error;
      }
      failed = true;
      process.stderr.write(
        `\n${packageName} fails with its SDK floors. Raise the floor to a version that passes, and say why in the changeset.\n`,
      );
    }
  }
  return !failed;
});

if (!passed) {
  process.exit(1);
}
process.stdout.write(
  `\nSDK floors pass: ${found.map((floor) => `${floor.sdk}@${floor.version}`).join(", ")}\n`,
);
