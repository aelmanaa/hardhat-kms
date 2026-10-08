// Compares the Node.js minimum that Hardhat enforces at startup with the floor of `engines.node`
// in packages/hardhat-kms/package.json. The support policy (docs/user/reference/support.md) says the
// two are equal, and Hardhat has raised its minimum in a patch release before (3.4.3 moved it from
// 22.10.0 to 22.13.0). scripts/test-hardhat-versions.ts runs this for each Hardhat version it
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
 * Checks that the Node.js minimum of a Hardhat version equals the floor of our `engines.node`.
 *
 * @param hardhatVersion - The Hardhat version, for the message.
 * @param hardhatMinimum - Hardhat's MIN_SUPPORTED_NODE_VERSION.
 * @param enginesNode - `engines.node` of packages/hardhat-kms/package.json.
 * @returns `undefined` when they are equal, otherwise a message naming both values.
 */
export function nodeFloorMismatch(
  hardhatVersion: string,
  hardhatMinimum: Version,
  enginesNode: string,
): string | undefined {
  const ours = nodeFloorOf(enginesNode);
  const difference = compareVersions(hardhatMinimum, ours);
  if (difference === 0) {
    return undefined;
  }
  const values = `hardhat ${hardhatVersion} requires Node.js ${formatVersion(hardhatMinimum)}, and engines.node of hardhat-kms is ${enginesNode} (floor ${formatVersion(ours)}).`;
  return difference > 0
    ? `${values} On Node.js ${formatVersion(ours)}, Hardhat exits at startup. Raise engines.node of every package to >=${formatVersion(hardhatMinimum)} in the next minor release (docs/user/reference/support.md).`
    : `${values} engines.node asks for more than this Hardhat needs, and the support policy sets it to Hardhat's minimum: raise the hardhat peer floor to a release with the same minimum, or lower engines.node (docs/user/reference/support.md).`;
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
  const loaded: unknown = await import(pathToFileURL(file).href);
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
      `${file} does not export MIN_SUPPORTED_NODE_VERSION as three integers; update scripts/node-floor.ts to where Hardhat keeps its Node.js minimum`,
    );
  }
  return [Number(constant[0]), Number(constant[1]), Number(constant[2])];
}
