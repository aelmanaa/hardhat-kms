// Checks a version on the registry before it goes to `latest`: the first step of the promotion
// workflow, and what no other package check covers. The version must be stable, published for the
// four packages, at their `beta` dist-tag and not below `latest`; the published core's `gitHead`
// must be the commit of tag `v<version>`; and in a scratch project `npm install --ignore-scripts`
// of the four packages followed by `npm audit signatures` must verify a provenance attestation for
// each. The guards are in scripts/registry-release.ts.
//
// Usage: node scripts/check-registry-release.ts <version> [--registry <url>]
//   --registry runs the checks against another registry, for a rehearsal with a local one. The
//   scratch install runs against it too; only npmjs serves signing keys, so `npm audit signatures`
//   is not run and the summary says so. The promotion workflow does not pass --registry.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withPackDirectory } from "./pack.ts";
import {
  assertAttestations,
  assertBetaTag,
  assertGitHead,
  assertNotBelowLatest,
  assertPublished,
  parseGitHead,
  parsePackageView,
  parseVerified,
  stableVersion,
} from "./registry-release.ts";
import {
  assertInstalledVersion,
  PACKAGES,
  parseRegistryOptions,
  registryArguments,
  type RegistryOptions,
} from "./registry.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// .cmd files need a shell on Windows (CVE-2024-27980 hardening in child_process).
const shell = process.platform === "win32";

const usage = "usage: node scripts/check-registry-release.ts <version> [--registry <url>]";
const options = ((): RegistryOptions => {
  let parsed: RegistryOptions;
  try {
    // The version is positional here; `--from-registry` is the other scripts' spelling.
    parsed = parseRegistryOptions(process.argv.slice(2), false);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage}\n`);
    process.exit(1);
  }
  const version = parsed.rest[0];
  if (parsed.version !== undefined || version === undefined || parsed.rest.length > 1) {
    process.stderr.write(`${usage}\n`);
    process.exit(1);
  }
  return { ...parsed, version };
})();
const { registry } = options;
const version = String(options.version);

/** Runs npm and returns its standard output; a failing `npm view` still prints JSON. */
function npmJson(args: string[], cwd: string = root): string {
  try {
    return execFileSync(npm, [...args, "--json", ...registryArguments(registry)], {
      cwd,
      shell,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stdout: unknown = Reflect.get(Object(error), "stdout");
    if (typeof stdout === "string" && stdout.trim() !== "") {
      return stdout;
    }
    throw error;
  }
}

const ok = (what: string): void => {
  process.stdout.write(`ok   ${what}\n`);
};

try {
  stableVersion(version);
  ok(`${version} is a stable version`);

  const views = PACKAGES.map((name) =>
    parsePackageView(name, npmJson(["view", name, "dist-tags", "versions"])),
  );
  assertPublished(views, version);
  ok(`${version} is published for ${PACKAGES.join(", ")}`);
  assertBetaTag(views, version);
  ok(`beta is ${version} for the four packages`);
  assertNotBelowLatest(views, version);
  const latest = views[0]?.distTags.latest;
  ok(latest === undefined ? "no latest yet" : `latest is ${latest}, not above ${version}`);

  const tagCommit = ((): string => {
    try {
      return execFileSync(
        "git",
        ["rev-parse", "--verify", "--quiet", `refs/tags/v${version}^{commit}`],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
    } catch {
      throw new Error(
        `tag v${version} is not in this checkout; run git fetch origin tag v${version}`,
      );
    }
  })();
  const gitHead = parseGitHead(npmJson(["view", `hardhat-kms@${version}`, "gitHead"]));
  assertGitHead(gitHead, tagCommit, version);
  ok(`hardhat-kms@${version} was published from the commit of tag v${version} (${tagCommit})`);

  withPackDirectory((work) => {
    const scratch = path.join(work, "scratch");
    mkdirSync(scratch);
    writeFileSync(
      path.join(scratch, "package.json"),
      JSON.stringify({ name: "scratch", private: true }, null, 2),
    );
    execFileSync(
      npm,
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        ...registryArguments(registry),
        ...PACKAGES.map((name) => `${name}@${version}`),
      ],
      { cwd: scratch, shell, stdio: "inherit" },
    );
    assertInstalledVersion(scratch, version);
    ok(`a scratch project installs the four packages and resolves hardhat-kms ${version}`);
    if (registry === undefined) {
      const verified = parseVerified(
        npmJson(["audit", "signatures", "--include-attestations"], scratch),
      );
      assertAttestations(verified, version);
      ok(
        `npm audit signatures verified a provenance attestation for the four packages at ${version}`,
      );
    } else {
      process.stdout.write(
        `skip attestations: --registry ${registry} given, and only npmjs serves signing keys\n`,
      );
    }
  });
  process.stdout.write(
    registry === undefined
      ? `\n${version} is ready to promote\n`
      : `\n${version} passed the checks that run against ${registry}\n`,
  );
} catch (error) {
  process.stderr.write(`\nFAIL ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
