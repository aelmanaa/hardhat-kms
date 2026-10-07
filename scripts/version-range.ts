// Reads the floor of a dependency range for the scripts that test a floor
// (scripts/test-sdk-floors.ts). A tested range is a caret range on the floor, such as `^6.5.0`. It
// may skip releases of the same major, such as a deprecated one, as alternatives joined by `||`:
// `^6.5.0 <6.11.0 || ^6.11.1` allows 6.5.0 up to 6.10.x, then 6.11.1 and later 6.x releases. Every
// alternative is a caret range on the same major, so the range never allows another major, and the
// first alternative's version is the floor.

/** One alternative: `^x.y.z`, optionally with an upper bound `<x.b.c` in the same major. */
const ALTERNATIVE = /^\^(\d+)\.(\d+)\.(\d+)(?: <(\d+)\.(\d+)\.(\d+))?$/;

type Version = readonly [number, number, number];

/** Negative when `a` comes before `b`, zero when equal, positive after. */
function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function format(version: Version): string {
  return version.join(".");
}

/**
 * The floor of a tested dependency range: the version of its first caret alternative.
 *
 * @param range - The range from package.json, such as `^6.5.0` or `^6.5.0 <6.11.0 || ^6.11.1`.
 * @returns The floor, such as `6.5.0`.
 * @throws When the range has another form, starts at a 0.x version, allows another major, or
 * lists its alternatives out of order or overlapping.
 */
export function floorOf(range: string): string {
  const form =
    "must be a caret range on a tested version, such as ^1.2.3, or one that skips releases of the same major, such as ^1.2.3 <1.4.0 || ^1.4.1";
  const alternatives = range.split("||").map((part) => {
    const match = ALTERNATIVE.exec(part.trim());
    if (match === null) {
      throw new Error(`${form} (got ${range})`);
    }
    const [, a, b, c, d, e, f] = match;
    const low: Version = [Number(a), Number(b), Number(c)];
    const high: Version | undefined =
      d === undefined ? undefined : [Number(d), Number(e), Number(f)];
    return { low, high };
  });
  const first = alternatives[0];
  if (first === undefined) {
    throw new Error(`${form} (got ${range})`);
  }
  const major = first.low[0];
  if (major === 0) {
    throw new Error(
      `a caret range on 0.x allows one minor only; use a 1.0.0 or later floor (got ${range})`,
    );
  }
  alternatives.forEach(({ low, high }, index) => {
    if (low[0] !== major || (high !== undefined && high[0] !== major)) {
      throw new Error(`every alternative must stay in major ${major} (got ${range})`);
    }
    if (high !== undefined && compare(high, low) <= 0) {
      throw new Error(`<${format(high)} must be above ^${format(low)} (got ${range})`);
    }
    const previous = alternatives[index - 1];
    if (previous !== undefined) {
      if (previous.high === undefined || compare(low, previous.high) < 0) {
        throw new Error(
          `each alternative must start at or above the previous one's upper bound (got ${range})`,
        );
      }
    }
  });
  return format(first.low);
}
