// Tests each provider package against the lowest version of its cloud SDK that its range allows,
// and hardhat-kms against the lowest viem its optional peer range allows. CI tests the lockfile
// version everywhere else; once Dependabot moves the lockfile forward, this is the only check that
// the declared floor still works.
//
// viem is an optional peer dependency that only connection.kms.getAccount loads, so its floor runs
// the tests of getAccount, not the whole package.
//
// For each package in packages/ whose dependencies include a cloud SDK, it installs the floor of
// each SDK range (`^3.1143.0` gives 3.1143.0), also as a workspace override so other SDKs that
// depend on it load the floor too, checks that this version is the one the package
// resolves, typechecks the package against it and runs the package's tests. package.json files,
// pnpm-workspace.yaml and the lockfile are restored afterwards, even on Ctrl-C, and the install is
// redone from the restored lockfile.
//
// Usage: node scripts/test-sdk-floors.ts
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
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

/**
 * Package names of cloud SDKs: the dependencies whose floor matters. google-gax is the transport
 * under @google-cloud/kms. hardhat-kms-gcp depends on it directly and hands it to the client, so
 * its floor is what runs: releases before 6.5.0 never enforce the per-call deadline over REST.
 * google-auth-library signs the Cloud Logging reads of `kms history` in hardhat-kms-gcp.
 */
const CLOUD_SDK = /^(@(aws-sdk|google-cloud|azure)\/|google-gax$|google-auth-library$)/;

/** Optional peer dependencies whose floor is tested, with the test files that cover them. */
const PEER_FLOOR_TESTS: Readonly<Record<string, readonly string[]>> = {
  viem: [
    "test/unit/viem/account.test.ts",
    "test/unit/viem/refusals.test.ts",
    "test/unit/viem/types.test.ts",
    "test/unit/viem/nonce-manager.test.ts",
    "test/integration/get-account.test.ts",
    "test/integration/raw-send.test.ts",
  ],
};

interface Floor {
  packageName: string;
  directory: string;
  sdk: string;
  version: string;
  /** A cloud SDK the package depends on, or an optional peer dependency. */
  kind: "dependency" | "peer";
}

/** The floor of a caret range, which is the only form allowed for a tested dependency. */
function floorOf(packageName: string, sdk: string, range: string): string {
  const match = /^\^(\d+\.\d+\.\d+)$/.exec(range);
  if (match?.[1] === undefined) {
    throw new Error(
      `${packageName}: ${sdk} must use a caret range on a tested version, such as ^1.2.3 (got ${range})`,
    );
  }
  return match[1];
}

/** Finds the cloud SDK and optional peer floors of every package. */
function floors(): Floor[] {
  const packagesDirectory = path.join(root, "packages");
  return readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const directory = path.join(packagesDirectory, entry.name);
      const manifest = readJson(path.join(directory, "package.json"));
      const packageName = String(manifest.name);
      const dependencies = Object.entries(stringRecord(manifest.dependencies))
        .filter(([sdk]) => CLOUD_SDK.test(sdk))
        .map(([sdk, range]) => ({
          packageName,
          directory,
          sdk,
          version: floorOf(packageName, sdk, range),
          kind: "dependency" as const,
        }));
      const peers = Object.entries(stringRecord(manifest.peerDependencies))
        .filter(([sdk]) => Object.hasOwn(PEER_FLOOR_TESTS, sdk))
        .map(([sdk, range]) => ({
          packageName,
          directory,
          sdk,
          version: floorOf(packageName, sdk, range),
          kind: "peer" as const,
        }));
      return [...dependencies, ...peers];
    });
}

const found = floors();
if (found.length === 0) {
  process.stdout.write("No package depends on a cloud SDK or a tested peer.\n");
  process.exit(0);
}

// Everything `pnpm add` may rewrite. pnpm-workspace.yaml gets the floors as overrides, and a
// minimumReleaseAgeExclude entry when a floor is younger than the release-age policy allows.
const restorable = [
  path.join(root, "pnpm-lock.yaml"),
  path.join(root, "pnpm-workspace.yaml"),
  ...new Set(found.map((floor) => path.join(floor.directory, "package.json"))),
];

const passed = await withRestoredFiles(restorable, async () => {
  let failed = false;
  // A floor can also be a dependency of another SDK, as google-gax is of @google-cloud/kms. An
  // override makes every package in the workspace resolve the floor, so the SDK's own copy and its
  // types are the floor too, not only the provider package's direct dependency.
  const workspace = path.join(root, "pnpm-workspace.yaml");
  if (/^overrides:/m.test(readFileSync(workspace, "utf8"))) {
    throw new Error("pnpm-workspace.yaml already has overrides; merge the floors into them");
  }
  appendFileSync(
    workspace,
    `\noverrides:\n${found.map((floor) => `  "${floor.sdk}": "${floor.version}"\n`).join("")}`,
  );
  for (const floor of found.filter((candidate) => candidate.kind === "dependency")) {
    process.stdout.write(`\n== ${floor.packageName}: ${floor.sdk}@${floor.version}\n`);
    run([
      "--filter",
      floor.packageName,
      "add",
      `${floor.sdk}@${floor.version}`,
      "--save-exact",
      "--ignore-scripts",
    ]);
  }
  // A peer floor reaches the package through the override, which an install applies.
  run(["install", "--no-frozen-lockfile", "--ignore-scripts"]);
  for (const floor of found) {
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
  const testRuns = [
    ...new Set(
      found.filter((floor) => floor.kind === "dependency").map((floor) => floor.packageName),
    ),
  ].map((packageName) => ({ packageName, args: ["--filter", packageName, "run", "test"] }));
  for (const floor of found.filter((candidate) => candidate.kind === "peer")) {
    const files = PEER_FLOOR_TESTS[floor.sdk] ?? [];
    testRuns.push({
      packageName: `${floor.packageName} (${floor.sdk} ${floor.version})`,
      args: [
        "--filter",
        floor.packageName,
        "exec",
        "node",
        "--test",
        "--test-concurrency=1",
        ...files,
      ],
    });
  }
  for (const { packageName, args } of testRuns) {
    try {
      run(args);
    } catch (error) {
      await deliverSignals();
      if (wasInterrupted()) {
        throw error;
      }
      failed = true;
      process.stderr.write(
        `\n${packageName} fails with its floors. Raise the floor to a version that passes, and say why in the changeset.\n`,
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
