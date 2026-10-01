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
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
// .cmd files need a shell on Windows (CVE-2024-27980 hardening in child_process).
const shell = process.platform === "win32";
/** Set when Ctrl-C or SIGTERM stops the script or the command it runs. */
let interrupted = false;

/**
 * Lets Node deliver a pending SIGINT or SIGTERM to the listeners below. They cannot run while a
 * command runs synchronously, and pnpm may exit with status 1 when interrupted.
 */
async function deliverSignals(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const run = (args: string[]): void => {
  try {
    execFileSync(pnpm, args, { cwd: root, stdio: "inherit", shell });
  } catch (error) {
    // Ctrl-C reaches the child too. It ends by the signal or exits with 128 + its number.
    const signal: unknown = Reflect.get(Object(error), "signal");
    const status: unknown = Reflect.get(Object(error), "status");
    if (signal === "SIGINT" || signal === "SIGTERM" || status === 130 || status === 143) {
      interrupted = true;
    }
    throw error;
  }
};

/** Package names of cloud SDKs: the dependencies whose floor matters. */
const CLOUD_SDK = /^@(aws-sdk|google-cloud|azure)\//;

interface Floor {
  packageName: string;
  directory: string;
  sdk: string;
  version: string;
}

function readJson(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${file} is not a JSON object`);
  }
  return { ...parsed };
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
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

/** The version of a dependency that a package resolves, read from the installed package.json. */
function resolvedVersion(directory: string, sdk: string): string {
  const require = createRequire(path.join(directory, "package.json"));
  // Read the manifest from the package's folder: an SDK's `exports` may not expose package.json.
  const entry = require.resolve(sdk);
  const marker = `${path.sep}node_modules${path.sep}${sdk.split("/").join(path.sep)}${path.sep}`;
  const end = entry.lastIndexOf(marker);
  if (end === -1) {
    throw new Error(`${sdk} resolved to ${entry}, outside a node_modules/${sdk} folder`);
  }
  const folder = entry.slice(0, end + marker.length);
  return String(readJson(path.join(folder, "package.json")).version);
}

const found = floors();
if (found.length === 0) {
  process.stdout.write("No package depends on a cloud SDK.\n");
  process.exit(0);
}

// Everything `pnpm add` may rewrite, restored in `finally`. pnpm-workspace.yaml gets a
// minimumReleaseAgeExclude entry when a floor is younger than the release-age policy allows.
const restorable = [
  path.join(root, "pnpm-lock.yaml"),
  path.join(root, "pnpm-workspace.yaml"),
  ...new Set(found.map((floor) => path.join(floor.directory, "package.json"))),
];
const originals = new Map(restorable.map((file) => [file, readFileSync(file, "utf8")]));

// On Ctrl-C or SIGTERM the running pnpm command ends, `run` throws and `finally` restores the
// files. Without these listeners Node would exit at once and leave the floors installed.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    interrupted = true;
  });
}

let failed = false;
try {
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
      if (interrupted) {
        throw error;
      }
      failed = true;
      process.stderr.write(
        `\n${packageName} fails with its SDK floors. Raise the floor to a version that passes, and say why in the changeset.\n`,
      );
    }
  }
} finally {
  await deliverSignals();
  for (const [file, content] of originals) {
    writeFileSync(file, content);
  }
  const reinstall = "run `pnpm install --frozen-lockfile` to reinstall the lockfile versions";
  if (interrupted) {
    process.stderr.write(`\nInterrupted. The files are restored; ${reinstall}.\n`);
    // Exit here: the error that the interruption raised would otherwise end the script with 1.
    process.exit(130);
  } else {
    try {
      run(["install", "--frozen-lockfile", "--ignore-scripts"]);
    } catch {
      process.stderr.write(`\nThe files are restored, but reinstalling failed: ${reinstall}.\n`);
    }
  }
}

if (failed) {
  process.exit(1);
}
process.stdout.write(
  `\nSDK floors pass: ${found.map((floor) => `${floor.sdk}@${floor.version}`).join(", ")}\n`,
);
