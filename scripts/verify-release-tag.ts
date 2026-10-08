// Decides whether a `vX.Y.Z` tag may start a release. The release workflow runs it first, and a
// maintainer can run it before pushing a tag. Four checks, in this order, each failing with one line:
// 1. The tag is annotated and carries an OpenPGP signature by a key in `.github/release-keys/`.
//    The keys are imported into a throwaway GNUPGHOME, so the caller's keyring plays no part, and
//    `git verify-tag --raw` is parsed by its status lines, never by its human output.
// 2. The tag name is `v` + the version of `packages/hardhat-kms/package.json` at the tagged commit,
//    and the four package manifests carry that same version.
// 3. The version is a plain `X.Y.Z`, with no `-` prerelease tag and no `+` build metadata: only
//    the stable line releases from `main`.
// 4. The tagged commit is an ancestor of `origin/main`, or of `origin/release/X.Y` for a hotfix
//    of version X.Y.Z. The release branch name comes from the version in the manifests, which
//    check 2 tied to the tag name; nothing the tag's pusher writes elsewhere can name a branch.
//
// Usage:
//   node scripts/verify-release-tag.ts vX.Y.Z [--keys DIR] [--main REF]
// Exit code 0 when the tag passes, 1 when it fails or the script cannot decide. `--keys` defaults
// to `.github/release-keys` and `--main` to `origin/main`, which must be fetched. The release
// branch is read from `refs/remotes/origin/release/X.Y` when it has been fetched.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The directory of maintainer public keys, relative to the repository root. */
export const KEYS_DIRECTORY = ".github/release-keys";
/** The ref the tagged commit must be reachable from. */
export const MAIN_REF = "origin/main";
/** The remote-tracking namespace of the release branches, one `release/X.Y` per hotfix line. */
export const RELEASE_REFS = "refs/remotes/origin/release/";
/** The manifest whose version the tag name must match. */
export const PRIMARY_MANIFEST = "packages/hardhat-kms/package.json";
/** The four manifests that must carry the same version. */
export const MANIFESTS: readonly string[] = [
  PRIMARY_MANIFEST,
  "packages/hardhat-kms-aws/package.json",
  "packages/hardhat-kms-azure/package.json",
  "packages/hardhat-kms-gcp/package.json",
];

const HOME_PREFIX = "hardhat-kms-release-keys-";
const PGP_SIGNATURE = "-----BEGIN PGP SIGNATURE-----";
const PRIVATE_KEY = "PRIVATE KEY";
const PUBLIC_KEY_BEGIN = "-----BEGIN PGP PUBLIC KEY BLOCK-----";
const PUBLIC_KEY_END = "-----END PGP PUBLIC KEY BLOCK-----";
/** A stable version: three numbers, no prerelease tag, no build metadata. */
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
/** The same, with the major and minor captured. */
const STABLE_VERSION_PARTS = /^(\d+)\.(\d+)\.\d+$/;

/** What the script needs to know about where it runs. */
export interface VerifyOptions {
  /** The tag name, for example `v1.2.3`. */
  tag: string;
  /** The repository to look in. */
  cwd: string;
  /** The environment for `git` and `gpg`; the script adds `GNUPGHOME` to it. */
  env: NodeJS.ProcessEnv;
  /** The key directory; defaults to {@link KEYS_DIRECTORY} under `cwd`. */
  keysDirectory?: string;
  /** The ref the tagged commit must be reachable from; defaults to {@link MAIN_REF}. */
  mainRef?: string;
}

/** The one-line reason a tag fails. */
export interface Failure {
  ok: false;
  reason: string;
}

/** Who signed the tag, once the signature is accepted. */
export interface Signature {
  ok: true;
  /** The user id of the key that signed the tag. */
  signer: string;
  /** The fingerprint of the primary key that signed the tag. */
  fingerprint: string;
}

/** The outcome: what passed, or the one-line reason the tag fails. */
export type Verdict =
  | (Signature & {
      /** The released version, without the `v`. */
      version: string;
      /** The tagged commit. */
      commit: string;
      /** The branch the commit is on: the main ref, or the release branch of the version. */
      branch: string;
    })
  | Failure;

/** What a command returned. */
export interface Command {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(file: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Command {
  const result = spawnSync(file, [...args], { cwd, env, encoding: "utf8" });
  if (result.error !== undefined) {
    throw new Error(`cannot run ${file}: ${result.error.message}`, { cause: result.error });
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Command {
  return run("git", args, cwd, env);
}

// Importing public keys and verifying need no agent, so gpg must not start one: an agent would
// outlive the throwaway home, and a long home path can make its socket path too long.
function gpg(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Command {
  return run(
    "gpg",
    ["--batch", "--no-tty", "--no-autostart", "--status-fd", "1", ...args],
    cwd,
    env,
  );
}

/** Runs a command and returns its exit status and output; throws when it cannot start. */
export type RunCommand = (
  file: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) => Command;

/** Turns an absolute path into the spelling `gpg` and `gpgconf` read. */
export type GpgPath = (file: string) => string;

/**
 * Makes the function that spells paths the way `gpg` and `gpgconf` read them. On Linux and macOS,
 * and with a native Windows build of `gpg`, that is the path itself. Git for Windows ships an MSYS
 * build of `gpg`, which takes `C:\...` for a relative path; for it the path becomes the POSIX form
 * `cygpath -u` gives, for example `/c/...`. Which build runs is read once, on the first path, from
 * the home directory `gpg --version` prints: `/c/...` from the MSYS build, `C:\...` from a native
 * one. On Linux and macOS nothing runs.
 * @param cwd The directory to run `gpg` and `cygpath` in.
 * @param env The environment for `gpg` and `cygpath`.
 * @param runCommand Runs `gpg` and `cygpath`; tests pass a stub.
 * @param platform The platform Node runs on; tests pass `win32` to reach the Windows branches.
 * @returns The function; it throws when `gpg` is the MSYS build and `cygpath` cannot convert a path.
 */
export function gpgPathFor(
  cwd: string,
  env: NodeJS.ProcessEnv,
  runCommand: RunCommand = run,
  platform: NodeJS.Platform = process.platform,
): GpgPath {
  if (platform !== "win32") {
    return (file) => file;
  }
  let posix: boolean | undefined;
  return (file) => {
    if (posix === undefined) {
      const { GNUPGHOME: _, ...withoutHome } = env;
      const version = runCommand("gpg", ["--version"], cwd, withoutHome).stdout;
      posix = /^Home: (.*)$/m.exec(version)?.[1]?.startsWith("/") ?? false;
    }
    if (!posix) {
      return file;
    }
    const converted = runCommand("cygpath", ["-u", file], cwd, env);
    if (converted.status !== 0) {
      throw new Error(`cygpath cannot convert ${file}: ${converted.stderr.trim()}`);
    }
    return converted.stdout.trim();
  };
}

/**
 * Removes the throwaway GNUPGHOME. The removal is recursive, so the function accepts only a
 * `${HOME_PREFIX}*` directory directly under the system temp directory: a wrong edit to this file
 * must not be able to remove the temp directory itself or anything outside it.
 * @param directory The directory `verifyReleaseTag` created.
 */
export function removeKeyHome(directory: string): void {
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== path.resolve(tmpdir()) ||
    !path.basename(resolved).startsWith(HOME_PREFIX)
  ) {
    throw new Error(
      `refusing to remove ${directory}: not a ${HOME_PREFIX}* directory under ${tmpdir()}`,
    );
  }
  rmSync(resolved, { recursive: true, force: true });
}

/** The status lines of a `git verify-tag --raw` run, without the `[GNUPG:] ` prefix. */
function statusLines(command: Command): string[] {
  return `${command.stdout}\n${command.stderr}`
    .split(/\r?\n/)
    .filter((line) => line.startsWith("[GNUPG:] "))
    .map((line) => line.slice("[GNUPG:] ".length));
}

/** The space-separated field of a status line, or "" when it is missing. */
function field(line: string, index: number): string {
  return line.split(" ")[index] ?? "";
}

/** The rest of a status line after `count` fields. */
function after(line: string, count: number): string {
  return line.split(" ").slice(count).join(" ").trim();
}

/**
 * Reads the status lines of a signature check.
 * @param lines The status lines, see {@link statusLines}.
 * @param trusted The primary fingerprints of the imported keys.
 * @returns The signer and fingerprint, or the reason the signature fails.
 */
export function readSignature(
  lines: readonly string[],
  trusted: ReadonlySet<string>,
): Signature | Failure {
  for (const line of lines) {
    const kind = field(line, 0);
    if (kind === "BADSIG") {
      return {
        ok: false,
        reason: `the signature does not match the tag (key ${field(line, 1)}); the tag was changed after signing, re-create it with git tag -s`,
      };
    }
    if (kind === "EXPKEYSIG" || kind === "REVKEYSIG") {
      const state = kind === "EXPKEYSIG" ? "expired" : "revoked";
      return {
        ok: false,
        reason: `the signing key ${field(line, 1)} is ${state}; sign with a current key that is in ${KEYS_DIRECTORY}`,
      };
    }
    if (kind === "EXPSIG") {
      return {
        ok: false,
        reason: `the signature by key ${field(line, 1)} has expired; re-create the tag with git tag -s`,
      };
    }
    if (kind === "NO_PUBKEY") {
      return {
        ok: false,
        reason: `signed by key ${field(line, 1)}, which is not in ${KEYS_DIRECTORY}`,
      };
    }
  }
  const valid = lines.find((line) => field(line, 0) === "VALIDSIG");
  const good = lines.find((line) => field(line, 0) === "GOODSIG");
  if (valid === undefined || good === undefined) {
    return {
      ok: false,
      reason: `gpg reported no valid signature on the tag; re-create it with git tag -s using a key in ${KEYS_DIRECTORY}`,
    };
  }
  // VALIDSIG ends with the fingerprint of the primary key, also when a subkey signed.
  const fingerprint = field(valid, 10);
  if (!trusted.has(fingerprint)) {
    return {
      ok: false,
      reason: `signed by key ${fingerprint}, which is not in ${KEYS_DIRECTORY}`,
    };
  }
  return { ok: true, signer: after(good, 2), fingerprint };
}

/**
 * Reads the primary fingerprints of the keys an import added, from its status lines.
 * @param lines The status lines of `gpg --import`, see {@link statusLines}.
 * @returns The fingerprints, one per imported or already present key.
 */
export function importedFingerprints(lines: readonly string[]): Set<string> {
  const fingerprints = new Set<string>();
  for (const line of lines) {
    // IMPORT_OK <reason> <fingerprint>: the fingerprint is the primary key's.
    const [kind, , fingerprint] = line.split(" ");
    if (kind === "IMPORT_OK" && fingerprint !== undefined && fingerprint !== "") {
      fingerprints.add(fingerprint);
    }
  }
  return fingerprints;
}

/**
 * Whether a key file is exactly one armored public-key block, as `gpg --armor --export` writes it.
 * @param text The file's content.
 * @returns True for one block with nothing before or after it.
 */
export function isOnePublicKeyBlock(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith(PUBLIC_KEY_BEGIN) &&
    trimmed.endsWith(PUBLIC_KEY_END) &&
    trimmed.indexOf("-----BEGIN") === trimmed.lastIndexOf("-----BEGIN") &&
    trimmed.indexOf("-----END") === trimmed.lastIndexOf("-----END")
  );
}

/**
 * Imports every `.asc` file of the key directory into `home`, which is spelled for `gpg`;
 * `gpgPath` spells each key file the same way.
 * @returns The primary fingerprints imported, or the reason the import fails.
 */
function importKeys(
  keysDirectory: string,
  home: string,
  gpgPath: GpgPath,
  cwd: string,
  env: NodeJS.ProcessEnv,
): { ok: true; fingerprints: Set<string> } | Failure {
  let names: string[];
  try {
    names = readdirSync(keysDirectory)
      .filter((name) => name.endsWith(".asc"))
      .toSorted();
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `cannot read the key directory ${keysDirectory}: ${detail}` };
  }
  if (names.length === 0) {
    return { ok: false, reason: `no release keys: ${keysDirectory} has no .asc file` };
  }
  const fingerprints = new Set<string>();
  for (const name of names) {
    const file = path.join(keysDirectory, name);
    const text = readFileSync(file, "utf8");
    if (text.includes(PRIVATE_KEY)) {
      return {
        ok: false,
        reason: `${file} contains a private key; remove it, revoke that key, and commit only the output of gpg --armor --export`,
      };
    }
    // One armored public-key block per file, so a reviewer sees in the diff exactly what the
    // file holds: a binary export, a secret-key export or a second block appended to a good key
    // all fail here, whatever gpg would make of them.
    if (!isOnePublicKeyBlock(text)) {
      return {
        ok: false,
        reason: `${file} is not one armored public key block; commit only the output of gpg --armor --export <key-id>`,
      };
    }
    // The exit status says nothing useful: gpg exits 2 when it cannot reach an agent it does not
    // need. The IMPORT_OK status lines say what was imported.
    const imported = importedFingerprints(
      statusLines(gpg(["--homedir", home, "--import", gpgPath(file)], cwd, env)),
    );
    if (imported.size === 0) {
      return {
        ok: false,
        reason: `${file} is not an importable OpenPGP public key; re-export it with gpg --armor --export <key-id>`,
      };
    }
    if (imported.size > 1) {
      return {
        ok: false,
        reason: `${file} holds ${imported.size} keys; one key per file, named after its maintainer`,
      };
    }
    for (const fingerprint of imported) {
      fingerprints.add(fingerprint);
    }
  }
  return { ok: true, fingerprints };
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/**
 * Reads the `version` of a manifest at a commit.
 * @returns The version, or the reason it cannot be read.
 */
function manifestVersion(
  manifest: string,
  commit: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): { ok: true; version: string } | Failure {
  const shown = git(["show", `${commit}:${manifest}`], cwd, env);
  if (shown.status !== 0) {
    return { ok: false, reason: `${manifest} is missing at the tagged commit` };
  }
  const parsed = parseJson(shown.stdout);
  if (!parsed.ok) {
    return { ok: false, reason: `${manifest} at the tagged commit is not JSON` };
  }
  const version: unknown =
    typeof parsed.value === "object" && parsed.value !== null
      ? Reflect.get(parsed.value, "version")
      : undefined;
  if (typeof version !== "string" || version === "") {
    return { ok: false, reason: `${manifest} at the tagged commit has no version` };
  }
  return { ok: true, version };
}

function checkSignature(options: VerifyOptions, keysDirectory: string): Signature | Failure {
  const { tag, cwd, env } = options;
  const ref = git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], cwd, env);
  if (ref.status !== 0) {
    return { ok: false, reason: `tag ${tag} does not exist` };
  }
  const type = git(["cat-file", "-t", `refs/tags/${tag}`], cwd, env);
  if (type.stdout.trim() !== "tag") {
    return {
      ok: false,
      reason: `tag ${tag} is lightweight; a release tag is signed with git tag -s`,
    };
  }
  const object = git(["cat-file", "tag", `refs/tags/${tag}`], cwd, env);
  if (!object.stdout.includes(PGP_SIGNATURE)) {
    return {
      ok: false,
      reason: `tag ${tag} is annotated but has no OpenPGP signature; re-create it with git tag -s`,
    };
  }
  const home = mkdtempSync(path.join(tmpdir(), HOME_PREFIX));
  // `home` itself is what removeKeyHome checks and removes; `gpg` gets it in its own spelling.
  // A failed conversion throws before the `try` below, so it removes the home itself.
  const gpgPath = gpgPathFor(cwd, env);
  let gpgHome: string;
  try {
    gpgHome = gpgPath(home);
  } catch (error: unknown) {
    removeKeyHome(home);
    throw error;
  }
  const homeEnv: NodeJS.ProcessEnv = { ...env, GNUPGHOME: gpgHome };
  try {
    const keys = importKeys(keysDirectory, gpgHome, gpgPath, cwd, homeEnv);
    if (!keys.ok) {
      return keys;
    }
    const verified = git(
      [
        "-c",
        "gpg.program=gpg",
        "-c",
        "gpg.openpgp.program=gpg",
        "verify-tag",
        "--raw",
        `refs/tags/${tag}`,
      ],
      cwd,
      homeEnv,
    );
    const signature = readSignature(statusLines(verified), keys.fingerprints);
    if (!signature.ok) {
      return signature;
    }
    if (verified.status !== 0) {
      return { ok: false, reason: `git verify-tag rejected ${tag}: ${verified.stderr.trim()}` };
    }
    return signature;
  } finally {
    // gpg may have started an agent for this home; stop it before the directory goes. A missing
    // gpgconf is not an error: there is then no agent to stop.
    spawnSync("gpgconf", ["--homedir", gpgHome, "--kill", "gpg-agent"], { cwd, env: homeEnv });
    removeKeyHome(home);
  }
}

/**
 * The remote-tracking ref of the release branch for a version: `origin/release/X.Y` for X.Y.Z.
 * The name is built from the numbers of the version alone.
 * @param version A stable `X.Y.Z` version.
 * @returns The full ref and its short name, or undefined when the version is not `X.Y.Z`.
 */
export function releaseBranch(version: string): { ref: string; name: string } | undefined {
  const match = STABLE_VERSION_PARTS.exec(version);
  if (match === null) {
    return undefined;
  }
  const line = `${match[1]}.${match[2]}`;
  return { ref: `${RELEASE_REFS}${line}`, name: `origin/release/${line}` };
}

/**
 * Runs the four checks on a tag.
 * @param options The tag, the repository and the environment, see {@link VerifyOptions}.
 * @returns The verdict; it never throws for a failing tag, only when `git` or `gpg` cannot run.
 */
export function verifyReleaseTag(options: VerifyOptions): Verdict {
  const { tag, cwd, env } = options;
  const keysDirectory = options.keysDirectory ?? path.join(cwd, KEYS_DIRECTORY);
  const mainRef = options.mainRef ?? MAIN_REF;

  const signature = checkSignature(options, keysDirectory);
  if (!signature.ok) {
    return signature;
  }

  const commit = git(["rev-parse", `refs/tags/${tag}^{commit}`], cwd, env).stdout.trim();
  const primary = manifestVersion(PRIMARY_MANIFEST, commit, cwd, env);
  if (!primary.ok) {
    return primary;
  }
  if (tag !== `v${primary.version}`) {
    return {
      ok: false,
      reason: `tag ${tag} does not match version ${primary.version} in ${PRIMARY_MANIFEST}`,
    };
  }
  for (const manifest of MANIFESTS) {
    const other = manifestVersion(manifest, commit, cwd, env);
    if (!other.ok) {
      return other;
    }
    if (other.version !== primary.version) {
      return {
        ok: false,
        reason: `${manifest} has version ${other.version}, ${PRIMARY_MANIFEST} has ${primary.version}`,
      };
    }
  }

  if (!STABLE_VERSION.test(primary.version)) {
    return {
      ok: false,
      reason: `version ${primary.version} is not a stable X.Y.Z version; only stable versions release from main`,
    };
  }

  const head = git(["rev-parse", "--verify", "--quiet", `${mainRef}^{commit}`], cwd, env);
  if (head.status !== 0) {
    return { ok: false, reason: `${mainRef} is not fetched; run git fetch origin main` };
  }
  const onMain = git(["merge-base", "--is-ancestor", commit, mainRef], cwd, env);
  if (onMain.status === 0) {
    return { ...signature, version: primary.version, commit, branch: mainRef };
  }

  // A hotfix: the commit must be on the release branch of its own version. A tag v1.0.1 is
  // checked against origin/release/1.0 and no other branch.
  const release = releaseBranch(primary.version);
  if (release === undefined) {
    return { ok: false, reason: `commit ${commit} of ${tag} is not on ${mainRef}` };
  }
  const releaseHead = git(
    ["rev-parse", "--verify", "--quiet", `${release.ref}^{commit}`],
    cwd,
    env,
  );
  if (releaseHead.status === 0) {
    const onRelease = git(["merge-base", "--is-ancestor", commit, release.ref], cwd, env);
    if (onRelease.status === 0) {
      return { ...signature, version: primary.version, commit, branch: release.name };
    }
  }
  return {
    ok: false,
    reason: `commit ${commit} of ${tag} is not on ${mainRef} or ${release.name}`,
  };
}

function main(argv: readonly string[]): void {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { keys: { type: "string" }, main: { type: "string" } },
  });
  const tag = positionals[0];
  if (tag === undefined || positionals.length !== 1) {
    throw new Error("usage: node scripts/verify-release-tag.ts vX.Y.Z [--keys DIR] [--main REF]");
  }
  const cwd = process.cwd();
  const verdict = verifyReleaseTag({
    tag,
    cwd,
    env: process.env,
    ...(values.keys === undefined ? {} : { keysDirectory: path.resolve(cwd, values.keys) }),
    ...(values.main === undefined ? {} : { mainRef: values.main }),
  });
  if (!verdict.ok) {
    process.stderr.write(`${tag} fails: ${verdict.reason}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `${tag} passes: signed by ${verdict.signer} (${verdict.fingerprint}), version ${verdict.version} in ${MANIFESTS.length} manifests, commit ${verdict.commit} on ${verdict.branch}\n`,
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
