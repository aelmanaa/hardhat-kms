// Checks that the Node.js minimum Hardhat enforces at startup is not above the floor of
// `engines.node` in packages/hardhat-kms/package.json. Hardhat has raised its minimum in a patch
// release before (3.4.3 moved it from 22.10.0 to 22.13.0), and the support policy
// (docs/user/reference/support.md) then raises engines.node to match. Our floor may be higher than
// Hardhat's: a cloud SDK or an end-of-life drop can raise it on its own. scripts/test-hardhat-versions.ts runs this for each Hardhat version it
// installs.
//
// Hardhat's package.json has no `engines` field. The minimum lives in the constant
// MIN_SUPPORTED_NODE_VERSION of dist/src/internal/cli/node-version.js, so the check imports that
// file from the installed package rather than copying the value.
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** A version as `[major, minor, patch]`. */
export type Version = readonly [number, number, number];

/** The lower bound of one alternative of `engines.node`: `>=x.y.z`, `^x.y.z`, `~x.y.z` or `x.y.z`. */
const LOWER_BOUND = /^(?:>=|\^|~)?\s*v?(\d+)\.(\d+)\.(\d+)$/;

/** Negative when `a` comes before `b`, zero when equal, positive after. */
export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** A version as `major.minor.patch`. */
export function formatVersion(version: Version): string {
  return version.join(".");
}

/**
 * The lowest Node.js version an `engines.node` range allows.
 *
 * @param range - The range, such as `>=22.13.0` or `^22.13.0 || >=24.0.0`.
 * @returns The lowest lower bound across the `||` alternatives.
 * @throws When an alternative is not a single lower bound with a full version, such as
 * `>=22.13.0 <25.0.0`, `>22.13.0` or `22.x`.
 */
export function nodeFloorOf(range: string): Version {
  const floors = range.split("||").map((part): Version => {
    const match = LOWER_BOUND.exec(part.trim());
    if (match === null) {
      throw new Error(
        `engines.node must list lower bounds such as >=22.13.0, joined by || (got ${range})`,
      );
    }
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  });
  const [first, ...rest] = floors;
  if (first === undefined) {
    throw new Error(`engines.node is empty (got ${range})`);
  }
  return rest.reduce(
    (lowest, floor) => (compareVersions(floor, lowest) < 0 ? floor : lowest),
    first,
  );
}

/**
 * Checks that the Node.js minimum of a Hardhat version is not above the floor of our `engines.node`.
 *
 * @param hardhatVersion - The Hardhat version, for the message.
 * @param hardhatMinimum - Hardhat's MIN_SUPPORTED_NODE_VERSION.
 * @param enginesNode - `engines.node` of packages/hardhat-kms/package.json.
 * @returns `undefined` when Hardhat's minimum is at or below our floor, otherwise a message naming
 * both values.
 */
export function nodeFloorMismatch(
  hardhatVersion: string,
  hardhatMinimum: Version,
  enginesNode: string,
): string | undefined {
  const ours = nodeFloorOf(enginesNode);
  if (compareVersions(hardhatMinimum, ours) <= 0) {
    return undefined;
  }
  return `hardhat ${hardhatVersion} requires Node.js ${formatVersion(hardhatMinimum)}, above the engines.node floor of hardhat-kms, ${enginesNode} (floor ${formatVersion(ours)}). On Node.js ${formatVersion(ours)}, Hardhat exits at startup. Raise engines.node of every package to >=${formatVersion(hardhatMinimum)} in the next minor release (docs/user/reference/support.md).`;
}

/**
 * Reads MIN_SUPPORTED_NODE_VERSION from an installed Hardhat.
 *
 * @param hardhatDirectory - The folder of the installed hardhat package.
 * @throws When the file or the constant is missing, or the constant is not three integers.
 */
export async function readHardhatNodeMinimum(hardhatDirectory: string): Promise<Version> {
  const file = path.join(
    realpathSync(hardhatDirectory),
    "dist",
    "src",
    "internal",
    "cli",
    "node-version.js",
  );
  const update = "update scripts/node-floor.ts to where Hardhat keeps its Node.js minimum";
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(file).href);
  } catch (error) {
    throw new Error(`${file} could not be loaded; ${update}`, { cause: error });
  }
  const constant: unknown =
    typeof loaded === "object" && loaded !== null
      ? Object.getOwnPropertyDescriptor(loaded, "MIN_SUPPORTED_NODE_VERSION")?.value
      : undefined;
  if (
    !Array.isArray(constant) ||
    constant.length !== 3 ||
    !constant.every((part) => Number.isInteger(part))
  ) {
    throw new Error(
      `${file} does not export MIN_SUPPORTED_NODE_VERSION as three integers; ${update}`,
    );
  }
  return [Number(constant[0]), Number(constant[1]), Number(constant[2])];
}
