// Runs the transaction-filler differential test and the network hook test against the lowest
// Hardhat version the peer range allows and the latest Hardhat 3 release. The filler ports
// Hardhat's own fill logic (decision 0002), so a Hardhat release that changes how it fills a
// transaction must fail here. CI tests the lockfile version everywhere else.
//
// Hardhat comes from the pnpm catalog, so for each version the script rewrites the catalog entry
// in pnpm-workspace.yaml, installs, checks that hardhat-kms resolves that version, builds,
// typechecks hardhat-kms and runs the two test files. pnpm-workspace.yaml and the lockfile are
// restored afterwards, even on Ctrl-C, and the install is redone from the restored lockfile.
//
// After each install it also checks that the Node.js minimum the installed Hardhat enforces at
// startup is not above the floor of engines.node of hardhat-kms (scripts/node-floor.ts). A higher
// minimum fails the run; the build and tests still run for that version.
//
// "Latest" is the newest 3.x release that is at least a day old, or older than minimumReleaseAge
// if the project sets one. This is a deliberate supply-chain hold, not a pnpm limit: pnpm's
// built-in default is not strict and would install a younger release after adding it to
// minimumReleaseAgeExclude, which this repository never does. A younger release is reported as
// held back, and the next weekly run tests it.
//
// Usage: node scripts/test-hardhat-versions.ts [version...]
//   With versions, tests those instead of the floor and latest.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { nodeFloorMismatch, readHardhatNodeMinimum } from "./node-floor.ts";
import {
  deliverSignals,
  installedDirectory,
  output,
  readJson,
  resolvedVersion,
  root,
  run,
  stringRecord,
  wasInterrupted,
  withRestoredFiles,
} from "./temporary-install.ts";

const plugin = path.join(root, "packages", "hardhat-kms");
const workspaceFile = path.join(root, "pnpm-workspace.yaml");
const TESTS = [
  "test/integration/transaction-filler.test.ts",
  "test/integration/network-hook.test.ts",
];
/**
 * The release-age hold, in minutes, when the project sets no minimumReleaseAge: one day, the same
 * as pnpm's built-in default, but enforced here because that default is not strict.
 */
const DEFAULT_MINIMUM_RELEASE_AGE = 1440;
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;

type Stage = "install" | "node floor" | "build" | "typecheck" | "tests";
const HINTS: Record<Stage, string> = {
  install: "pnpm could not install it, or hardhat-kms resolves another version.",
  "node floor": "The Node.js floor check could not read Hardhat's minimum or engines.node.",
  build: "The packages do not compile against it.",
  typecheck: "hardhat-kms or its tests do not typecheck against it.",
  tests:
    "A failing transaction-filler test names the fill step that differs from Hardhat's; a network-hook failure means the hook behaves differently.",
};

interface Target {
  version: string;
  /** Why this version is tested: "floor", "latest" or "requested". */
  labels: string[];
}

/** The floor of the hardhat peer range of hardhat-kms. Only a caret range is allowed. */
function floor(): string {
  const range = stringRecord(readJson(path.join(plugin, "package.json")).peerDependencies).hardhat;
  const match = /^\^(\d+\.\d+\.\d+)$/.exec(range ?? "");
  if (match?.[1] === undefined) {
    throw new Error(
      `hardhat-kms: the hardhat peer range must be a caret range, such as ^3.18.0 (got ${range})`,
    );
  }
  return match[1];
}

function compareVersions(left: string, right: string): number {
  const a = STABLE.exec(left)?.slice(1).map(Number) ?? [];
  const b = STABLE.exec(right)?.slice(1).map(Number) ?? [];
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/** The release-age hold in minutes: the project's minimumReleaseAge, or one day. */
function minimumReleaseAge(): number {
  const configured: unknown = JSON.parse(
    output(["config", "get", "minimumReleaseAge", "--json"]) || "null",
  );
  return typeof configured === "number" ? configured : DEFAULT_MINIMUM_RELEASE_AGE;
}

/**
 * The newest stable 3.x release older than the release-age hold. Younger releases are held back
 * on purpose, so the script never needs a minimumReleaseAgeExclude entry.
 */
function latest(): string {
  const published = stringRecord(JSON.parse(output(["view", "hardhat", "time", "--json"])));
  const releases = Object.keys(published)
    .filter((version) => STABLE.exec(version)?.[1] === "3")
    .toSorted((left, right) => compareVersions(right, left));
  const ageMinutes = minimumReleaseAge();
  const cutoff = Date.now() - ageMinutes * 60_000;
  const tooYoung: string[] = [];
  for (const version of releases) {
    if (Date.parse(published[version] ?? "") <= cutoff) {
      if (tooYoung.length > 0) {
        process.stdout.write(
          `Holding back hardhat ${tooYoung.join(", ")}: published less than ${ageMinutes} minutes ago (release-age hold; the next weekly run tests it). Testing ${version} as latest.\n`,
        );
      }
      return version;
    }
    tooYoung.push(version);
  }
  throw new Error(`No hardhat 3.x release is older than ${ageMinutes} minutes`);
}

function targets(requested: string[]): Target[] {
  const chosen: [string, string][] =
    requested.length > 0
      ? requested.map((version) => [version, "requested"])
      : [
          [floor(), "floor"],
          [latest(), "latest"],
        ];
  const byVersion = new Map<string, Target>();
  for (const [version, label] of chosen) {
    const target = byVersion.get(version) ?? { version, labels: [] };
    target.labels.push(label);
    byVersion.set(version, target);
  }
  return [...byVersion.values()];
}

const describe = (target: Target): string =>
  `hardhat ${target.version} (${target.labels.join(", ")})`;

/** pnpm-workspace.yaml with the catalog's hardhat entry set to `version`. */
function withCatalogVersion(workspace: string, version: string): string {
  const entry = /^(\s+"?hardhat"?:\s*)"[^"]*"\s*$/m;
  const matches = workspace.match(new RegExp(entry, "gm")) ?? [];
  if (matches.length !== 1) {
    throw new Error("pnpm-workspace.yaml must have one catalog entry for hardhat");
  }
  return workspace.replace(entry, `$1"${version}"`);
}

/**
 * The Node.js floor check of scripts/node-floor.ts for the hardhat that hardhat-kms resolves.
 * Each version is a new folder in the pnpm store, so importing its node-version.js never returns
 * the module of a version installed earlier in the run.
 */
async function checkNodeFloor(version: string): Promise<string | undefined> {
  const hardhat = installedDirectory(plugin, "hardhat");
  const enginesNode = stringRecord(readJson(path.join(plugin, "package.json")).engines).node;
  if (enginesNode === undefined) {
    throw new Error("packages/hardhat-kms/package.json has no engines.node");
  }
  const minimum = await readHardhatNodeMinimum(hardhat);
  process.stdout.write(`hardhat ${version} requires Node.js ${minimum.join(".")}\n`);
  return nodeFloorMismatch(version, minimum, enginesNode);
}

const chosen = targets(process.argv.slice(2));
process.stdout.write(`Testing ${chosen.map(describe).join(" and ")}\n`);

const workspace = readFileSync(workspaceFile, "utf8");
const failures: string[] = [];
await withRestoredFiles([path.join(root, "pnpm-lock.yaml"), workspaceFile], async () => {
  for (const target of chosen) {
    process.stdout.write(`\n== ${describe(target)}\n`);
    let stage: Stage = "install";
    try {
      writeFileSync(workspaceFile, withCatalogVersion(workspace, target.version));
      run(["install", "--no-frozen-lockfile", "--ignore-scripts"]);
      const installed = resolvedVersion(plugin, "hardhat");
      if (installed !== target.version) {
        throw new Error(`hardhat-kms resolves hardhat ${installed}, not ${target.version}`);
      }
      stage = "node floor";
      const mismatch = await checkNodeFloor(target.version);
      if (mismatch !== undefined) {
        failures.push(`${describe(target)} at node floor`);
        process.stderr.write(`\n${describe(target)} fails at the node floor stage. ${mismatch}\n`);
      }
      stage = "build";
      run(["run", "build"]);
      stage = "typecheck";
      // Typecheck the tests too: they use Hardhat's types.
      run(["exec", "tsc", "-b", plugin]);
      stage = "tests";
      run([
        "--fail-if-no-match",
        "--filter",
        "hardhat-kms",
        "exec",
        "node",
        "--test",
        "--test-concurrency=1",
        "--test-timeout=120000",
        ...TESTS,
      ]);
    } catch (error) {
      await deliverSignals();
      if (wasInterrupted()) {
        throw error;
      }
      failures.push(`${describe(target)} at ${stage}`);
      process.stderr.write(`\n${describe(target)} fails at the ${stage} stage. ${HINTS[stage]}\n`);
      if ((stage === "install" || stage === "node floor") && error instanceof Error) {
        process.stderr.write(`${error.message}\n`);
      }
    }
  }
  return failures.length === 0;
});

if (failures.length > 0) {
  process.stderr.write(`\nFailed: ${failures.join(", ")}\n`);
  process.exit(1);
}
process.stdout.write(`\nHardhat versions pass: ${chosen.map(describe).join(", ")}\n`);
