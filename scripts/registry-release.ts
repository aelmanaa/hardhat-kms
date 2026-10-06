// The guards of scripts/check-registry-release.ts, as functions of parsed `npm view`, `npm audit
// signatures` and git output, so the tests can feed them recorded output. Each guard throws an
// error whose message names the check that failed and the values it compared.
import { PACKAGES } from "./registry.ts";

/** What `npm view <package> --json dist-tags versions` returns. */
export interface PackageView {
  name: string;
  distTags: Record<string, string>;
  versions: string[];
}

/** One entry of the `verified` list of `npm audit signatures --json --include-attestations`. */
export interface VerifiedPackage {
  name: string;
  version: string;
  /** Whether the entry carries a provenance attestation, not only a registry signature. */
  provenance: boolean;
}

/** A stable `major.minor.patch` version: no prerelease, no build metadata. */
const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** The field of an object, or undefined when `value` is not an object. */
function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

/** npm's `error.summary` when its JSON output carries one, else the whole error. */
function npmError(error: unknown): string {
  const summary = field(error, "summary");
  return typeof summary === "string" ? summary : JSON.stringify(error);
}

/**
 * Checks that a version can go to `latest`: exact `major.minor.patch`, with no prerelease or build
 * suffix.
 *
 * @param version - The version to promote.
 * @returns Its three numbers.
 */
export function stableVersion(version: string): [number, number, number] {
  const match = STABLE_VERSION.exec(version);
  if (match === null) {
    throw new Error(
      version.includes("-")
        ? `${version} is a prerelease; only a stable major.minor.patch version goes to latest`
        : `${version} is not a major.minor.patch version`,
    );
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Compares two stable versions.
 *
 * @returns Negative when `a` is lower, 0 when equal, positive when `a` is higher.
 */
export function compareVersions(a: string, b: string): number {
  const left = stableVersion(a);
  const right = stableVersion(b);
  return left.map((part, index) => part - (right[index] ?? 0)).find((d) => d !== 0) ?? 0;
}

/**
 * Parses the output of `npm view <package> --json dist-tags versions`.
 *
 * @param name - The package the output is for.
 * @param json - npm's output. An empty output means the package has no published version.
 */
export function parsePackageView(name: string, json: string): PackageView {
  if (json.trim() === "") {
    throw new Error(`${name} has no published version`);
  }
  const parsed: unknown = JSON.parse(json);
  const error = field(parsed, "error");
  if (error !== undefined) {
    throw new Error(`npm view ${name} failed: ${npmError(error)}`);
  }
  const distTags = field(parsed, "dist-tags");
  const versions = field(parsed, "versions");
  if (typeof distTags !== "object" || distTags === null) {
    throw new Error(`npm view ${name} returned no dist-tags`);
  }
  return {
    name,
    distTags: Object.fromEntries(
      Object.entries(distTags).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    // npm prints one version as a string and several as an array.
    versions:
      typeof versions === "string"
        ? [versions]
        : Array.isArray(versions)
          ? versions.filter((version): version is string => typeof version === "string")
          : [],
  };
}

/**
 * Parses the output of `npm view <package>@<version> --json gitHead`.
 *
 * @returns The commit, or undefined when the published manifest has no `gitHead`.
 */
export function parseGitHead(json: string): string | undefined {
  if (json.trim() === "") {
    return undefined;
  }
  const parsed: unknown = JSON.parse(json);
  return typeof parsed === "string" && parsed !== "" ? parsed : undefined;
}

/**
 * Parses the output of `npm audit signatures --json --include-attestations`.
 *
 * @returns The packages npm verified, with whether each has a provenance attestation.
 */
export function parseVerified(json: string): VerifiedPackage[] {
  const parsed: unknown = JSON.parse(json);
  const error = field(parsed, "error");
  if (error !== undefined) {
    throw new Error(`npm audit signatures failed: ${npmError(error)}`);
  }
  const verified = field(parsed, "verified");
  if (!Array.isArray(verified)) {
    throw new Error("npm audit signatures returned no verified list");
  }
  return verified.flatMap((entry: unknown): VerifiedPackage[] => {
    const name = field(entry, "name");
    const version = field(entry, "version");
    if (typeof name !== "string" || typeof version !== "string") {
      return [];
    }
    const provenance = field(field(entry, "attestations"), "provenance");
    return [{ name, version, provenance: typeof provenance === "object" && provenance !== null }];
  });
}

/** Every package must have the version. */
export function assertPublished(views: readonly PackageView[], version: string): void {
  const missing = views.filter((view) => !view.versions.includes(version)).map((v) => v.name);
  if (missing.length > 0) {
    throw new Error(`${version} is not published for ${missing.join(", ")}`);
  }
}

/** Every package's `beta` dist-tag must point at the version. */
export function assertBetaTag(views: readonly PackageView[], version: string): void {
  for (const view of views) {
    const beta = view.distTags.beta;
    if (beta !== version) {
      throw new Error(
        beta === undefined
          ? `${view.name} has no beta dist-tag; release.yml publishes to beta first`
          : `${view.name} has beta at ${beta}, not ${version}`,
      );
    }
  }
}

/**
 * The version must not be below `latest` where one exists. Equal is allowed: the first publish
 * of a package lands on `latest` and `beta` at once, and its verification run checks that version.
 */
export function assertNotBelowLatest(views: readonly PackageView[], version: string): void {
  for (const view of views) {
    const latest = view.distTags.latest;
    if (latest === undefined) {
      continue;
    }
    if (STABLE_VERSION.exec(latest) === null) {
      throw new Error(
        `${view.name} has latest at ${latest}, which is not a stable version; fix the dist-tag first`,
      );
    }
    if (compareVersions(version, latest) < 0) {
      throw new Error(
        `${view.name} has latest at ${latest}; ${version} is lower and would move latest backwards`,
      );
    }
  }
}

/** The published core's `gitHead` must be the commit of the release tag. */
export function assertGitHead(
  gitHead: string | undefined,
  tagCommit: string,
  version: string,
): void {
  if (gitHead === undefined) {
    throw new Error(
      `hardhat-kms@${version} has no gitHead in the registry, so it cannot be tied to tag v${version} (${tagCommit})`,
    );
  }
  if (gitHead !== tagCommit) {
    throw new Error(
      `hardhat-kms@${version} was published from ${gitHead}, but tag v${version} is ${tagCommit}`,
    );
  }
}

/** Each of the four packages at the version must carry a verified provenance attestation. */
export function assertAttestations(verified: readonly VerifiedPackage[], version: string): void {
  const missing = PACKAGES.filter(
    (name) =>
      !verified.some(
        (entry) => entry.name === name && entry.version === version && entry.provenance,
      ),
  );
  if (missing.length > 0) {
    throw new Error(
      `npm audit signatures verified no provenance attestation for ${missing.map((name) => `${name}@${version}`).join(", ")}`,
    );
  }
}
