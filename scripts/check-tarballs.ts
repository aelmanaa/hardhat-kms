// Checks the four release tarballs against a list of SHA-256 sums and against the release they
// belong to. release.yml runs it twice: in `pack`, right after packing, and in `publish` and the
// dry run, on the downloaded artifact, against the sums `pack` passed as a job output. The sums
// therefore travel outside the artifact they cover, so a swapped artifact fails here.
// For each line of the sums file, in order:
// - the file name is a plain `*.tgz` name and the file exists in the directory;
// - its SHA-256 equals the listed sum;
// - its package/package.json names the package expected at that position (the core first, then
//   the providers, as scripts/registry.ts lists them), at the release version, with `gitHead` set
//   to the tagged commit.
// The directory must hold no other tarball, and the version must be a stable X.Y.Z.
//
// Usage: node scripts/check-tarballs.ts --dir DIR --sums FILE --version X.Y.Z --commit SHA
// Prints one line per tarball, or the first failure, and exits 1 on a failure.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { PACKAGES } from "./registry.ts";

/** One line of a `sha256sum` listing. */
export interface SumLine {
  sha256: string;
  file: string;
}

/** What the manifest inside a tarball must say. */
export interface Expected {
  name: string;
  version: string;
  commit: string;
}

const SUM_LINE = /^([0-9a-f]{64}) {2}([\w.@-]+\.tgz)$/;

/**
 * Parses a `sha256sum` listing of the four tarballs.
 * @param text - The listing, one `<sum>  <file>` line per tarball.
 * @returns The lines, in order.
 * @throws When a line is malformed or the count is not the number of packages.
 */
export function parseSums(text: string): SumLine[] {
  const lines = text.split(/\r?\n/).filter((line) => line !== "");
  const sums = lines.map((line, index) => {
    const match = SUM_LINE.exec(line);
    if (match === null) {
      throw new Error(
        `sums line ${index + 1} is not "<sha256>  <name>.tgz": ${JSON.stringify(line)}`,
      );
    }
    return { sha256: match[1] ?? "", file: match[2] ?? "" };
  });
  if (sums.length !== PACKAGES.length) {
    throw new Error(`the sums list ${sums.length} tarballs; a release has ${PACKAGES.length}`);
  }
  return sums;
}

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

/**
 * Checks the manifest of one tarball.
 * @param file - The tarball's name, for the message.
 * @param manifestText - Its package/package.json.
 * @param expected - The package, version and commit it must carry.
 * @throws When a field differs, naming the field and both values.
 */
export function checkManifest(file: string, manifestText: string, expected: Expected): void {
  const manifest: unknown = JSON.parse(manifestText);
  for (const [key, want] of [
    ["name", expected.name],
    ["version", expected.version],
    ["gitHead", expected.commit],
  ] as const) {
    const actual = field(manifest, key);
    if (actual !== want) {
      throw new Error(`${file}: ${key} is ${JSON.stringify(actual)}, expected ${want}`);
    }
  }
}

/**
 * Runs every check on a directory of tarballs.
 * @param directory - The directory the tarballs are in.
 * @param sumsText - The `sha256sum` listing they must match.
 * @param version - The release version.
 * @param commit - The tagged commit.
 * @returns One line per tarball.
 */
export function checkTarballs(
  directory: string,
  sumsText: string,
  version: string,
  commit: string,
): string[] {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `version ${version} is not a stable X.Y.Z; a prerelease is never staged from main`,
    );
  }
  const sums = parseSums(sumsText);
  const listed = new Set(sums.map((sum) => sum.file));
  const extra = readdirSync(directory).filter((name) => name.endsWith(".tgz") && !listed.has(name));
  if (extra.length > 0) {
    throw new Error(`${directory} holds tarballs the sums do not list: ${extra.join(", ")}`);
  }
  return sums.map((sum, index) => {
    const tarball = path.join(directory, sum.file);
    if (!existsSync(tarball)) {
      throw new Error(`${sum.file} is listed in the sums but missing`);
    }
    const actual = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    if (actual !== sum.sha256) {
      throw new Error(`${sum.file}: SHA-256 is ${actual}, the pack job recorded ${sum.sha256}`);
    }
    const name = PACKAGES[index] ?? "";
    const manifest = execFileSync("tar", ["-xOzf", tarball, "package/package.json"], {
      encoding: "utf8",
    });
    checkManifest(sum.file, manifest, { name, version, commit });
    return `ok   ${name}@${version} gitHead ${commit} ${sum.file} ${sum.sha256}`;
  });
}

function main(argv: readonly string[]): void {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      dir: { type: "string" },
      sums: { type: "string" },
      version: { type: "string" },
      commit: { type: "string" },
    },
  });
  const { dir, sums, version, commit } = values;
  if (dir === undefined || sums === undefined || version === undefined || commit === undefined) {
    throw new Error(
      "usage: node scripts/check-tarballs.ts --dir DIR --sums FILE --version X.Y.Z --commit SHA",
    );
  }
  const lines = checkTarballs(dir, readFileSync(sums, "utf8"), version, commit);
  process.stdout.write(`${lines.join("\n")}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`FAIL ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
