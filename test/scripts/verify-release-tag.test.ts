// The release tag checks of `scripts/verify-release-tag.ts`, against a temporary repository with
// a bare `origin`, and tags signed by temporary keys under temporary GNUPGHOMEs. Skipped when `gpg`
// is absent. Runs in `pnpm test`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MANIFESTS,
  gpgPathFor,
  importedFingerprints,
  isOnePublicKeyBlock,
  readSignature,
  releaseBranch,
  removeKeyHome,
  verifyReleaseTag,
} from "../../scripts/verify-release-tag.ts";

const script = fileURLToPath(new URL("../../scripts/verify-release-tag.ts", import.meta.url));
const hasGpg = spawnSync("gpg", ["--version"]).status === 0;

// Signing needs a gpg-agent, and its socket lives in the key's home. A Unix socket path is at
// most 104 bytes on macOS (108 on Linux), and GnuPG falls back to /run/user only on Linux, so a
// long temp directory makes key generation fail with "File name too long" rather than test the
// script. The suite then skips and says so.
const SOCKET_PATH_MAX = 104;
const longestSocketPath = path.join(tmpdir(), "hardhat-kms-test-XXXXXX", "g1", "S.gpg-agent.extra");
const skip = hasGpg
  ? longestSocketPath.length < SOCKET_PATH_MAX
    ? false
    : `temp directory ${tmpdir()} is too long for gpg's agent socket path (${longestSocketPath.length} >= ${SOCKET_PATH_MAX} bytes); set TMPDIR to a shorter directory`
  : "gpg is not installed";

function run(
  file: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(file, [...args], { cwd, env, encoding: "utf8" });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function mustRun(
  file: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  const result = run(file, args, cwd, env);
  assert.equal(result.status, 0, `${file} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/**
 * A key pair in its own GNUPGHOME; the home's path is short so the agent socket fits.
 * @returns The home as `gpg` spells it (see `gpgPathFor`), and the key's fingerprint.
 */
function generateKey(
  directory: string,
  name: string,
  env: NodeJS.ProcessEnv,
): { home: string; fingerprint: string } {
  mkdirSync(directory, { mode: 0o700 });
  const home = gpgPathFor(directory, env)(directory);
  mustRun(
    "gpg",
    [
      "--batch",
      "--homedir",
      home,
      "--pinentry-mode",
      "loopback",
      "--passphrase",
      "",
      "--quick-generate-key",
      `${name} <${name.toLowerCase().replaceAll(" ", "-")}@example.invalid>`,
      "ed25519",
      "sign",
      "0",
    ],
    directory,
    env,
  );
  const listed = mustRun(
    "gpg",
    ["--batch", "--homedir", home, "--with-colons", "--list-keys"],
    directory,
    env,
  );
  const fingerprint = /^fpr:+([0-9A-F]+):/m.exec(listed)?.[1];
  assert.notEqual(fingerprint, undefined);
  return { home, fingerprint: fingerprint ?? "" };
}

function stopAgent(home: string, env: NodeJS.ProcessEnv): void {
  spawnSync("gpgconf", ["--homedir", home, "--kill", "gpg-agent"], { env });
}

describe("verify-release-tag", { skip }, () => {
  // The script removes its throwaway GNUPGHOME with `rmSync(..., { recursive: true })`, so the
  // tests move the temp directory to one of their own. Node reads TMPDIR on Unix and TEMP, then
  // TMP, on Windows, so all three move.
  const variables = ["TMPDIR", "TEMP", "TMP"];
  const saved = new Map(variables.map((name) => [name, process.env[name]]));
  let sandbox = "";
  let repo = "";
  let keys = "";
  let trustedHome = "";
  let otherHome = "";
  let trustedKey = "";
  let otherKey = "";
  // Git reads no user or system config, so a `tag.gpgsign` or `gpg.format` on the machine that
  // runs the tests cannot change what the tags look like.
  let env: NodeJS.ProcessEnv = {};

  const git = (args: readonly string[], cwd: string = repo): string =>
    mustRun(
      "git",
      ["-c", "user.name=Release Test", "-c", "user.email=release-test@example.invalid", ...args],
      cwd,
      env,
    );
  const verify = (
    tag: string,
    options: {
      keysDirectory?: string;
      mainRef?: string;
      channel?: "stable" | "next";
      nextRef?: string;
    } = {},
  ) => verifyReleaseTag({ tag, cwd: repo, env, keysDirectory: keys, ...options });
  const writeManifests = (versions: Record<string, string>): void => {
    for (const manifest of MANIFESTS) {
      mkdirSync(path.dirname(path.join(repo, manifest)), { recursive: true });
      const version = versions[manifest] ?? versions["*"] ?? "0.0.0";
      writeFileSync(
        path.join(repo, manifest),
        `${JSON.stringify({ name: path.basename(path.dirname(manifest)), version }, null, 2)}\n`,
      );
    }
  };

  before(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), "hardhat-kms-test-"));
    for (const name of variables) {
      process.env[name] = sandbox;
    }
    assert.equal(path.resolve(tmpdir()), path.resolve(sandbox));
    env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: path.join(sandbox, "no-global-gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    };
    delete env.GNUPGHOME;

    // The homes are kept as `gpg` spells them: every later use passes them to `gpg` or `git`.
    ({ home: trustedHome, fingerprint: trustedKey } = generateKey(
      path.join(sandbox, "g1"),
      "Release Maintainer",
      env,
    ));
    ({ home: otherHome, fingerprint: otherKey } = generateKey(
      path.join(sandbox, "g2"),
      "Someone Else",
      env,
    ));
    keys = path.join(sandbox, "keys");
    mkdirSync(keys);
    writeFileSync(
      path.join(keys, "maintainer.asc"),
      mustRun(
        "gpg",
        ["--batch", "--homedir", trustedHome, "--armor", "--export", trustedKey],
        sandbox,
        env,
      ),
    );

    repo = path.join(sandbox, "repo");
    const origin = path.join(sandbox, "origin.git");
    mkdirSync(repo);
    git(["init", "--bare", "--quiet", "--initial-branch=main", origin], sandbox);
    git(["init", "--quiet", "--initial-branch=main"]);
    git(["remote", "add", "origin", origin]);
    writeManifests({ "*": "1.2.3" });
    git(["add", "."]);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "chore: version 1.2.3"]);
    git(["push", "--quiet", "origin", "main"]);
  });

  after(() => {
    for (const home of [trustedHome, otherHome]) {
      if (home !== "") {
        stopAgent(home, env);
      }
    }
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  const withTag = (name: string, create: () => void, check: () => void): void => {
    create();
    try {
      check();
    } finally {
      git(["tag", "-d", name]);
    }
  };

  // Signing happens with GNUPGHOME pointing at the signer's home; the script's calls get `env`.
  const signWith = (home: string, key: string, name: string, target = "HEAD"): void => {
    const signerEnv = { ...env, GNUPGHOME: home };
    mustRun(
      "git",
      [
        "-c",
        "user.name=Release Test",
        "-c",
        "user.email=release-test@example.invalid",
        "-c",
        `user.signingkey=${key}`,
        "-c",
        "gpg.program=gpg",
        "tag",
        "-s",
        name,
        "-m",
        name,
        target,
      ],
      repo,
      signerEnv,
    );
  };

  it("passes a tag signed by a key in the directory", () => {
    withTag(
      "v1.2.3",
      () => signWith(trustedHome, trustedKey, "v1.2.3"),
      () => {
        const verdict = verify("v1.2.3");
        assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.reason);
        if (verdict.ok) {
          assert.equal(verdict.version, "1.2.3");
          assert.equal(verdict.fingerprint, trustedKey);
          assert.match(verdict.signer, /^Release Maintainer </);
          assert.equal(verdict.commit, git(["rev-parse", "HEAD"]).trim());
        }
      },
    );
  });

  it("fails a lightweight tag", () => {
    withTag(
      "v1.2.3",
      () => git(["tag", "v1.2.3"]),
      () =>
        assert.deepEqual(verify("v1.2.3"), {
          ok: false,
          reason: "tag v1.2.3 is lightweight; a release tag is signed with git tag -s",
        }),
    );
  });

  it("fails an annotated tag without a signature", () => {
    withTag(
      "v1.2.3",
      () => git(["tag", "-a", "v1.2.3", "-m", "v1.2.3"]),
      () =>
        assert.deepEqual(verify("v1.2.3"), {
          ok: false,
          reason:
            "tag v1.2.3 is annotated but has no OpenPGP signature; re-create it with git tag -s",
        }),
    );
  });

  it("fails a tag signed by a key that is not in the directory", () => {
    withTag(
      "v1.2.3",
      () => signWith(otherHome, otherKey, "v1.2.3"),
      () => {
        const verdict = verify("v1.2.3");
        assert.equal(verdict.ok, false);
        if (!verdict.ok) {
          assert.match(
            verdict.reason,
            /^signed by key [0-9A-F]+, which is not in \.github\/release-keys$/,
          );
          assert.equal(verdict.reason.includes(trustedKey), false);
        }
      },
    );
  });

  it("fails every tag when the directory has no key", () => {
    const empty = path.join(sandbox, "no-keys");
    mkdirSync(empty);
    withTag(
      "v1.2.3",
      () => signWith(trustedHome, trustedKey, "v1.2.3"),
      () =>
        assert.deepEqual(verify("v1.2.3", { keysDirectory: empty }), {
          ok: false,
          reason: `no release keys: ${empty} has no .asc file`,
        }),
    );
  });

  it("refuses a key file that holds a private key", () => {
    const leaked = path.join(sandbox, "leaked-keys");
    mkdirSync(leaked);
    const file = path.join(leaked, "oops.asc");
    writeFileSync(
      file,
      "-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n-----END PGP PRIVATE KEY BLOCK-----\n",
    );
    withTag(
      "v1.2.3",
      () => signWith(trustedHome, trustedKey, "v1.2.3"),
      () =>
        assert.deepEqual(verify("v1.2.3", { keysDirectory: leaked }), {
          ok: false,
          reason: `${file} contains a private key; remove it, revoke that key, and commit only the output of gpg --armor --export`,
        }),
    );
  });

  it("refuses a key file with a second key block appended to a good key", () => {
    const appended = path.join(sandbox, "appended-keys");
    mkdirSync(appended);
    const file = path.join(appended, "maintainer.asc");
    const exportKey = (home: string, key: string): string =>
      mustRun("gpg", ["--batch", "--homedir", home, "--armor", "--export", key], sandbox, env);
    writeFileSync(file, exportKey(trustedHome, trustedKey) + exportKey(otherHome, otherKey));
    withTag(
      "v1.2.3",
      () => signWith(otherHome, otherKey, "v1.2.3"),
      () =>
        assert.deepEqual(verify("v1.2.3", { keysDirectory: appended }), {
          ok: false,
          reason: `${file} is not one armored public key block; commit only the output of gpg --armor --export <key-id>`,
        }),
    );
  });

  it("refuses a key file whose one block holds two keys", () => {
    // A home with both public keys exports them as one armored block.
    const bothDirectory = path.join(sandbox, "g3");
    mkdirSync(bothDirectory, { mode: 0o700 });
    const gpgPath = gpgPathFor(sandbox, env);
    const both = gpgPath(bothDirectory);
    for (const [home, key] of [
      [trustedHome, trustedKey],
      [otherHome, otherKey],
    ] as const) {
      const exported = mustRun(
        "gpg",
        ["--batch", "--homedir", home, "--armor", "--export", key],
        sandbox,
        env,
      );
      const keyFile = path.join(sandbox, "g3-import.asc");
      writeFileSync(keyFile, exported);
      mustRun(
        "gpg",
        ["--batch", "--no-autostart", "--homedir", both, "--import", gpgPath(keyFile)],
        sandbox,
        env,
      );
    }
    const twoKeys = path.join(sandbox, "two-keys");
    mkdirSync(twoKeys);
    const file = path.join(twoKeys, "maintainer.asc");
    writeFileSync(
      file,
      mustRun("gpg", ["--batch", "--homedir", both, "--armor", "--export"], sandbox, env),
    );
    withTag(
      "v1.2.3",
      () => signWith(otherHome, otherKey, "v1.2.3"),
      () =>
        assert.deepEqual(verify("v1.2.3", { keysDirectory: twoKeys }), {
          ok: false,
          reason: `${file} holds 2 keys; one key per file, named after its maintainer`,
        }),
    );
  });

  it("refuses a binary secret-key export named .asc", () => {
    const binary = path.join(sandbox, "binary-keys");
    mkdirSync(binary);
    const file = path.join(binary, "maintainer.asc");
    const exported = spawnSync(
      "gpg",
      [
        "--batch",
        "--homedir",
        trustedHome,
        "--pinentry-mode",
        "loopback",
        "--passphrase",
        "",
        "--export-secret-keys",
        trustedKey,
      ],
      { env },
    );
    assert.equal(exported.status, 0, exported.stderr.toString());
    assert.notEqual(exported.stdout.length, 0);
    writeFileSync(file, exported.stdout);
    withTag(
      "v1.2.3",
      () => signWith(trustedHome, trustedKey, "v1.2.3"),
      () =>
        assert.deepEqual(verify("v1.2.3", { keysDirectory: binary }), {
          ok: false,
          reason: `${file} is not one armored public key block; commit only the output of gpg --armor --export <key-id>`,
        }),
    );
  });

  it("fails a tag whose name is not the manifest version", () => {
    withTag(
      "v9.9.9",
      () => signWith(trustedHome, trustedKey, "v9.9.9"),
      () =>
        assert.deepEqual(verify("v9.9.9"), {
          ok: false,
          reason: "tag v9.9.9 does not match version 1.2.3 in packages/hardhat-kms/package.json",
        }),
    );
  });

  it("fails when the four manifests disagree", () => {
    git(["checkout", "--quiet", "-b", "disagree"]);
    try {
      writeManifests({ "*": "1.2.3", "packages/hardhat-kms-gcp/package.json": "1.2.4" });
      git(["commit", "--quiet", "--all", "--no-gpg-sign", "-m", "chore: gcp ahead"]);
      withTag(
        "v1.2.3",
        () => signWith(trustedHome, trustedKey, "v1.2.3"),
        () =>
          assert.deepEqual(verify("v1.2.3"), {
            ok: false,
            reason:
              "packages/hardhat-kms-gcp/package.json has version 1.2.4, packages/hardhat-kms/package.json has 1.2.3",
          }),
      );
    } finally {
      git(["checkout", "--quiet", "main"]);
      git(["branch", "--quiet", "-D", "disagree"]);
    }
  });

  it("fails a prerelease version", () => {
    git(["checkout", "--quiet", "-b", "prerelease"]);
    try {
      writeManifests({ "*": "2.0.0-next.1" });
      git(["commit", "--quiet", "--all", "--no-gpg-sign", "-m", "chore: version 2.0.0-next.1"]);
      withTag(
        "v2.0.0-next.1",
        () => signWith(trustedHome, trustedKey, "v2.0.0-next.1"),
        () =>
          assert.deepEqual(verify("v2.0.0-next.1"), {
            ok: false,
            reason:
              "version 2.0.0-next.1 is not a stable X.Y.Z version; only stable versions are released",
          }),
      );
    } finally {
      git(["checkout", "--quiet", "main"]);
      git(["branch", "--quiet", "-D", "prerelease"]);
    }
  });

  it("fails a version with build metadata", () => {
    git(["checkout", "--quiet", "-b", "build-metadata"]);
    try {
      writeManifests({ "*": "1.2.3+build.7" });
      git(["commit", "--quiet", "--all", "--no-gpg-sign", "-m", "chore: version 1.2.3+build.7"]);
      withTag(
        "v1.2.3+build.7",
        () => signWith(trustedHome, trustedKey, "v1.2.3+build.7"),
        () =>
          assert.deepEqual(verify("v1.2.3+build.7"), {
            ok: false,
            reason:
              "version 1.2.3+build.7 is not a stable X.Y.Z version; only stable versions are released",
          }),
      );
    } finally {
      git(["checkout", "--quiet", "main"]);
      git(["branch", "--quiet", "-D", "build-metadata"]);
    }
  });

  it("fails a tag whose commit is not on origin/main", () => {
    git(["checkout", "--quiet", "-b", "unmerged"]);
    try {
      writeFileSync(path.join(repo, "note.txt"), "not merged\n");
      git(["add", "note.txt"]);
      git(["commit", "--quiet", "--no-gpg-sign", "-m", "chore: unmerged"]);
      const commit = git(["rev-parse", "HEAD"]).trim();
      withTag(
        "v1.2.3",
        () => signWith(trustedHome, trustedKey, "v1.2.3"),
        () =>
          assert.deepEqual(verify("v1.2.3"), {
            ok: false,
            reason: `commit ${commit} of v1.2.3 is not on origin/main or origin/release/1.2`,
          }),
      );
    } finally {
      git(["checkout", "--quiet", "main"]);
      git(["branch", "--quiet", "-D", "unmerged"]);
    }
  });

  // Runs `check` with a commit at `version` on a new branch `name`, cut from main and pushed to
  // origin when `push` is set, then removes the branch on both sides. `extra` names more branches
  // to push at main for the duration, such as a release branch the commit is not on.
  const onBranch = (
    name: string,
    version: string,
    options: { push: boolean; extra?: readonly string[] },
    check: (commit: string) => void,
  ): void => {
    const pushed = [...(options.push ? [name] : []), ...(options.extra ?? [])];
    for (const branch of options.extra ?? []) {
      git(["push", "--quiet", "origin", `main:refs/heads/${branch}`]);
    }
    git(["checkout", "--quiet", "-b", name, "main"]);
    try {
      writeManifests({ "*": version });
      git(["commit", "--quiet", "--all", "--no-gpg-sign", "-m", `chore: version ${version}`]);
      if (options.push) {
        git(["push", "--quiet", "origin", name]);
      }
      check(git(["rev-parse", "HEAD"]).trim());
    } finally {
      git(["checkout", "--quiet", "main"]);
      git(["branch", "--quiet", "-D", name]);
      for (const branch of pushed) {
        git(["push", "--quiet", "origin", "--delete", branch]);
      }
    }
  };

  it("passes a hotfix tag on the release branch of its version", () => {
    onBranch("release/1.2", "1.2.4", { push: true }, (commit) =>
      withTag(
        "v1.2.4",
        () => signWith(trustedHome, trustedKey, "v1.2.4"),
        () => {
          const verdict = verify("v1.2.4");
          assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.reason);
          if (verdict.ok) {
            assert.equal(verdict.version, "1.2.4");
            assert.equal(verdict.commit, commit);
            assert.equal(verdict.branch, "origin/release/1.2");
            assert.equal(verdict.distTag, "release-1.2");
          }
        },
      ),
    );
  });

  it("names origin/main as the branch of a tag on main", () => {
    withTag(
      "v1.2.3",
      () => signWith(trustedHome, trustedKey, "v1.2.3"),
      () => {
        const verdict = verify("v1.2.3");
        assert.equal(verdict.ok && verdict.branch, "origin/main");
        assert.equal(verdict.ok && verdict.distTag, "beta");
      },
    );
  });

  it("fails a hotfix tag on the release branch of another line", () => {
    onBranch("release/1.1", "1.2.4", { push: true }, (commit) =>
      withTag(
        "v1.2.4",
        () => signWith(trustedHome, trustedKey, "v1.2.4"),
        () =>
          assert.deepEqual(verify("v1.2.4"), {
            ok: false,
            reason: `commit ${commit} of v1.2.4 is not on origin/main or origin/release/1.2`,
          }),
      ),
    );
  });

  it("fails a tag on a pushed branch that is not a release branch", () => {
    onBranch("hotfix-1.2", "1.2.4", { push: true, extra: ["release/1.2"] }, (commit) =>
      withTag(
        "v1.2.4",
        () => signWith(trustedHome, trustedKey, "v1.2.4"),
        () =>
          assert.deepEqual(verify("v1.2.4"), {
            ok: false,
            reason: `commit ${commit} of v1.2.4 is not on origin/main or origin/release/1.2`,
          }),
      ),
    );
  });

  it("fails a version whose line is not the release branch the commit is on", () => {
    // The commit is on origin/release/1.2, but version 1.3.0 belongs to release/1.3, which exists
    // and does not hold the commit.
    onBranch("release/1.2", "1.3.0", { push: true, extra: ["release/1.3"] }, (commit) =>
      withTag(
        "v1.3.0",
        () => signWith(trustedHome, trustedKey, "v1.3.0"),
        () =>
          assert.deepEqual(verify("v1.3.0"), {
            ok: false,
            reason: `commit ${commit} of v1.3.0 is not on origin/main or origin/release/1.3`,
          }),
      ),
    );
  });

  it("fails a hotfix tag whose release branch exists only locally", () => {
    onBranch("release/1.2", "1.2.4", { push: false }, (commit) =>
      withTag(
        "v1.2.4",
        () => signWith(trustedHome, trustedKey, "v1.2.4"),
        () =>
          assert.deepEqual(verify("v1.2.4"), {
            ok: false,
            reason: `commit ${commit} of v1.2.4 is not on origin/main or origin/release/1.2`,
          }),
      ),
    );
  });

  it("does not read the release branch from a tag that shadows its short name", () => {
    // A tag named origin/release/1.2 at the hotfix commit must not stand in for the branch.
    onBranch("hotfix-1.2", "1.2.4", { push: false }, (commit) =>
      withTag(
        "origin/release/1.2",
        () => git(["tag", "origin/release/1.2", commit]),
        () =>
          withTag(
            "v1.2.4",
            () => signWith(trustedHome, trustedKey, "v1.2.4"),
            () =>
              assert.deepEqual(verify("v1.2.4"), {
                ok: false,
                reason: `commit ${commit} of v1.2.4 is not on origin/main or origin/release/1.2`,
              }),
          ),
      ),
    );
  });

  it("fails when origin/main is not fetched", () => {
    withTag(
      "v1.2.3",
      () => signWith(trustedHome, trustedKey, "v1.2.3"),
      () =>
        assert.deepEqual(verify("v1.2.3", { mainRef: "origin/nowhere" }), {
          ok: false,
          reason: "origin/nowhere is not fetched; run git fetch origin main",
        }),
    );
  });

  it("passes a next tag whose commit is on origin/next, staged under next", () => {
    onBranch("next", "2.0.0-next.0", { push: true }, (commit) =>
      withTag(
        "v2.0.0-next.0",
        () => signWith(trustedHome, trustedKey, "v2.0.0-next.0"),
        () => {
          const verdict = verify("v2.0.0-next.0", { channel: "next" });
          assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.reason);
          if (verdict.ok) {
            assert.equal(verdict.version, "2.0.0-next.0");
            assert.equal(verdict.commit, commit);
            assert.equal(verdict.branch, "origin/next");
            assert.equal(verdict.distTag, "next");
          }
        },
      ),
    );
  });

  it("fails a next tag on the stable channel, so release.yml never stages one", () => {
    onBranch("next", "2.0.0-next.0", { push: true }, () =>
      withTag(
        "v2.0.0-next.0",
        () => signWith(trustedHome, trustedKey, "v2.0.0-next.0"),
        () =>
          assert.deepEqual(verify("v2.0.0-next.0"), {
            ok: false,
            reason:
              "version 2.0.0-next.0 is not a stable X.Y.Z version; only stable versions are released",
          }),
      ),
    );
  });

  it("fails a stable tag on the next channel, on main or on next", () => {
    withTag(
      "v1.2.3",
      () => signWith(trustedHome, trustedKey, "v1.2.3"),
      () =>
        assert.deepEqual(verify("v1.2.3", { channel: "next" }), {
          ok: false,
          reason:
            "version 1.2.3 is not an X.Y.Z-next.N version; release-next.yml stages only the next prereleases of the next branch",
        }),
    );
  });

  it("fails other prerelease names on the next channel", () => {
    for (const version of ["2.0.0-beta.0", "2.0.0-next", "2.0.0-next.0.1", "2.0.0-next.0+b"]) {
      onBranch("next", version, { push: true }, () =>
        withTag(
          `v${version}`,
          () => signWith(trustedHome, trustedKey, `v${version}`),
          () => {
            const verdict = verify(`v${version}`, { channel: "next" });
            assert.equal(verdict.ok, false, version);
            if (!verdict.ok) {
              assert.match(verdict.reason, /is not an X\.Y\.Z-next\.N version/, version);
            }
          },
        ),
      );
    }
  });

  it("fails a next tag whose commit is on main, a release branch or another branch, not on next", () => {
    // origin/next exists and holds only main's commit; the tagged commit is elsewhere.
    for (const branch of ["stray", "release/2.0"]) {
      onBranch(branch, "2.0.0-next.0", { push: true, extra: ["next"] }, (commit) =>
        withTag(
          "v2.0.0-next.0",
          () => signWith(trustedHome, trustedKey, "v2.0.0-next.0"),
          () =>
            assert.deepEqual(verify("v2.0.0-next.0", { channel: "next" }), {
              ok: false,
              reason: `commit ${commit} of v2.0.0-next.0 is not on origin/next`,
            }),
        ),
      );
    }
  });

  it("fails a next tag when origin/next is not fetched", () => {
    onBranch("next", "2.0.0-next.0", { push: true }, () =>
      withTag(
        "v2.0.0-next.0",
        () => signWith(trustedHome, trustedKey, "v2.0.0-next.0"),
        () =>
          assert.deepEqual(
            verify("v2.0.0-next.0", { channel: "next", nextRef: "origin/nowhere" }),
            {
              ok: false,
              reason: "origin/nowhere is not fetched; run git fetch origin next",
            },
          ),
      ),
    );
  });

  it("fails a tag that does not exist", () => {
    assert.deepEqual(verify("v0.0.1"), { ok: false, reason: "tag v0.0.1 does not exist" });
  });

  it("leaves no throwaway GNUPGHOME behind", () => {
    withTag(
      "v1.2.3",
      () => signWith(trustedHome, trustedKey, "v1.2.3"),
      () => {
        verify("v1.2.3");
        assert.deepEqual(
          readdirSync(sandbox).filter((name) => name.startsWith("hardhat-kms-release-keys-")),
          [],
        );
      },
    );
  });

  it("exits 0 on a good tag, 1 with the reason on a bad one, and 1 with usage when no tag is given", () => {
    // The Node 22 CI leg loads TypeScript through `NODE_OPTIONS=--import tsx`, which Node resolves
    // from the child's working directory. The temporary repository has no `node_modules`, so the
    // script's process gets the workspace's copy by URL. Any other option stays.
    const tsx = /(?:^|\s)--import(?:=|\s+)tsx(?=\s|$)/g;
    const nodeOptions = env["NODE_OPTIONS"] ?? "";
    const cliEnv: NodeJS.ProcessEnv = {
      ...env,
      NODE_OPTIONS: tsx.test(nodeOptions)
        ? nodeOptions.replaceAll(tsx, ` --import ${import.meta.resolve("tsx")} `).trim()
        : nodeOptions,
    };
    withTag(
      "v1.2.3",
      () => signWith(trustedHome, trustedKey, "v1.2.3"),
      () => {
        const output = path.join(sandbox, "github-output");
        writeFileSync(output, "earlier=line\n");
        const passed = run(
          process.execPath,
          [script, "v1.2.3", "--keys", keys, "--output", output],
          repo,
          cliEnv,
        );
        assert.equal(passed.status, 0, passed.stderr);
        assert.equal(readFileSync(output, "utf8"), "earlier=line\ndist-tag=beta\n");
        assert.match(
          passed.stdout,
          /^v1\.2\.3 passes: signed by Release Maintainer <[^>]+> \([0-9A-F]+\), version 1\.2\.3 in 4 manifests, commit [0-9a-f]{40} on origin\/main, staged under beta\n$/,
        );
        const failed = run(
          process.execPath,
          [script, "v1.2.3", "--keys", path.join(sandbox, "no-keys"), "--output", output],
          repo,
          cliEnv,
        );
        assert.equal(failed.status, 1);
        // Node 24.0.0 prints an ExperimentalWarning for the type stripping of an imported script
        // before the script's own line, so each stderr check matches a line.
        assert.match(failed.stderr, /^v1\.2\.3 fails: no release keys: /m);
        // A failing tag writes no dist-tag.
        assert.equal(readFileSync(output, "utf8"), "earlier=line\ndist-tag=beta\n");
      },
    );
    onBranch("next", "2.0.0-next.0", { push: true }, () =>
      withTag(
        "v2.0.0-next.0",
        () => signWith(trustedHome, trustedKey, "v2.0.0-next.0"),
        () => {
          const nextOutput = path.join(sandbox, "github-output-next");
          writeFileSync(nextOutput, "");
          const passed = run(
            process.execPath,
            [script, "v2.0.0-next.0", "--channel", "next", "--keys", keys, "--output", nextOutput],
            repo,
            cliEnv,
          );
          assert.equal(passed.status, 0, passed.stderr);
          assert.equal(readFileSync(nextOutput, "utf8"), "dist-tag=next\n");
          assert.match(
            passed.stdout,
            /^v2\.0\.0-next\.0 passes: .* version 2\.0\.0-next\.0 in 4 manifests, commit [0-9a-f]{40} on origin\/next, staged under next\n$/,
          );
          const stable = run(
            process.execPath,
            [script, "v2.0.0-next.0", "--keys", keys, "--output", nextOutput],
            repo,
            cliEnv,
          );
          assert.equal(stable.status, 1);
          assert.match(stable.stderr, /is not a stable X\.Y\.Z version/);
          assert.equal(readFileSync(nextOutput, "utf8"), "dist-tag=next\n");
        },
      ),
    );
    const usage = run(process.execPath, [script], repo, cliEnv);
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /^usage: /m);
    const channel = run(process.execPath, [script, "v1.2.3", "--channel", "beta"], repo, cliEnv);
    assert.equal(channel.status, 1);
    assert.match(channel.stderr, /^channel "beta" is not stable or next$/m);
  });
});

describe("releaseBranch", () => {
  it("names origin/release/X.Y from the major and minor of the version", () => {
    assert.deepEqual(releaseBranch("1.0.1"), {
      ref: "refs/remotes/origin/release/1.0",
      name: "origin/release/1.0",
      distTag: "release-1.0",
    });
    assert.deepEqual(releaseBranch("12.34.56"), {
      ref: "refs/remotes/origin/release/12.34",
      name: "origin/release/12.34",
      distTag: "release-12.34",
    });
  });

  it("names no branch for a version that is not X.Y.Z", () => {
    for (const version of ["1.0.1-next.1", "1.0.1+build", "1.0", "../1.0.1", "1.0.1\n", ""]) {
      assert.equal(releaseBranch(version), undefined, version);
    }
  });
});

describe("readSignature", () => {
  const trusted = new Set(["AAAA0000AAAA0000AAAA0000AAAA0000AAAA0000"]);
  const valid = [
    "NEWSIG",
    "GOODSIG 0000AAAA0000AAAA Release Maintainer <release-maintainer@example.invalid>",
    "VALIDSIG AAAA0000AAAA0000AAAA0000AAAA0000AAAA0000 2026-01-01 1767225600 0 4 0 22 10 00 AAAA0000AAAA0000AAAA0000AAAA0000AAAA0000",
    "TRUST_UNDEFINED 0 pgp",
  ];

  it("accepts a valid signature by a trusted primary key, whatever its trust level", () => {
    assert.deepEqual(readSignature(valid, trusted), {
      ok: true,
      signer: "Release Maintainer <release-maintainer@example.invalid>",
      fingerprint: "AAAA0000AAAA0000AAAA0000AAAA0000AAAA0000",
    });
  });

  it("accepts a signature by a subkey of a trusted key", () => {
    const bySubkey = valid.map((line) =>
      line.startsWith("VALIDSIG")
        ? "VALIDSIG BBBB0000BBBB0000BBBB0000BBBB0000BBBB0000 2026-01-01 1767225600 0 4 0 22 10 00 AAAA0000AAAA0000AAAA0000AAAA0000AAAA0000"
        : line,
    );
    const result = readSignature(bySubkey, trusted);
    assert.equal(result.ok, true);
  });

  it("rejects a valid signature by a key outside the directory", () => {
    assert.deepEqual(readSignature(valid, new Set()), {
      ok: false,
      reason:
        "signed by key AAAA0000AAAA0000AAAA0000AAAA0000AAAA0000, which is not in .github/release-keys",
    });
  });

  it("names a bad, expired or revoked signature", () => {
    assert.deepEqual(readSignature(["NEWSIG", "BADSIG 0000AAAA0000AAAA Someone"], trusted), {
      ok: false,
      reason:
        "the signature does not match the tag (key 0000AAAA0000AAAA); the tag was changed after signing, re-create it with git tag -s",
    });
    assert.deepEqual(readSignature(["EXPKEYSIG 0000AAAA0000AAAA Someone", ...valid], trusted), {
      ok: false,
      reason:
        "the signing key 0000AAAA0000AAAA is expired; sign with a current key that is in .github/release-keys",
    });
    assert.deepEqual(readSignature(["REVKEYSIG 0000AAAA0000AAAA Someone", ...valid], trusted), {
      ok: false,
      reason:
        "the signing key 0000AAAA0000AAAA is revoked; sign with a current key that is in .github/release-keys",
    });
    assert.deepEqual(
      readSignature(
        ["NEWSIG", "ERRSIG 0000AAAA0000AAAA 22 10 00 1 9 AAAA", "NO_PUBKEY 0000AAAA0000AAAA"],
        trusted,
      ),
      {
        ok: false,
        reason: "signed by key 0000AAAA0000AAAA, which is not in .github/release-keys",
      },
    );
    assert.deepEqual(readSignature([], trusted), {
      ok: false,
      reason:
        "gpg reported no valid signature on the tag; re-create it with git tag -s using a key in .github/release-keys",
    });
  });
});

const block = (body: string): string =>
  `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${body}\n-----END PGP PUBLIC KEY BLOCK-----\n`;

describe("isOnePublicKeyBlock", () => {
  it("accepts one armored public key block and nothing else", () => {
    assert.equal(isOnePublicKeyBlock(block("mQ==")), true);
    assert.equal(isOnePublicKeyBlock(block("mQ==") + block("mR==")), false);
    assert.equal(isOnePublicKeyBlock(`note\n${block("mQ==")}`), false);
    assert.equal(
      isOnePublicKeyBlock(
        "-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQ==\n-----END PGP PRIVATE KEY BLOCK-----\n",
      ),
      false,
    );
    assert.equal(isOnePublicKeyBlock("\u0099\u0001\u0003"), false);
    assert.equal(isOnePublicKeyBlock(""), false);
  });
});

describe("importedFingerprints", () => {
  it("takes the fingerprint of each IMPORT_OK line and ignores the rest", () => {
    assert.deepEqual(
      [
        ...importedFingerprints([
          "IMPORTED 0000AAAA0000AAAA Release Maintainer <release-maintainer@example.invalid>",
          "IMPORT_OK 1 AAAA0000AAAA0000AAAA0000AAAA0000AAAA0000",
          "IMPORT_OK 0 CCCC0000CCCC0000CCCC0000CCCC0000CCCC0000",
          "IMPORT_RES 2 0 1 0 1 0 0 0 0 0 0 0 0 0 0 0",
        ]),
      ],
      ["AAAA0000AAAA0000AAAA0000AAAA0000AAAA0000", "CCCC0000CCCC0000CCCC0000CCCC0000CCCC0000"],
    );
    assert.deepEqual(
      [...importedFingerprints(["NODATA 1", "IMPORT_RES 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0"])],
      [],
    );
  });
});

describe("gpgPathFor", () => {
  type Call = { file: string; args: readonly string[]; env: NodeJS.ProcessEnv };
  /** A stub that records each call and answers `gpg --version` and `cygpath -u`. */
  const stub = (home: string, cygpath: { status: number; stdout: string; stderr: string }) => {
    const calls: Call[] = [];
    const runCommand = (
      file: string,
      args: readonly string[],
      _cwd: string,
      env: NodeJS.ProcessEnv,
    ) => {
      calls.push({ file, args, env });
      return file === "gpg"
        ? { status: 0, stdout: `gpg (GnuPG) 2.4.8\nHome: ${home}\n`, stderr: "" }
        : cygpath;
    };
    return { calls, runCommand };
  };
  const env: NodeJS.ProcessEnv = { GNUPGHOME: "C:\\caller-home" };
  const file = "C:\\tmp\\hardhat-kms-release-keys-x";

  it("returns the path and runs nothing on Linux and macOS", () => {
    const { calls, runCommand } = stub("/c/x", { status: 0, stdout: "/c/y\n", stderr: "" });
    for (const platform of ["linux", "darwin"] as const) {
      assert.equal(gpgPathFor("cwd", env, runCommand, platform)(file), file);
    }
    assert.deepEqual(calls, []);
  });

  it("returns the path unchanged with a native Windows gpg", () => {
    const { calls, runCommand } = stub("C:\\gnupg", { status: 0, stdout: "/c/y\n", stderr: "" });
    const gpgPath = gpgPathFor("cwd", env, runCommand, "win32");
    assert.equal(gpgPath(file), file);
    assert.equal(gpgPath(`${file}\\key.asc`), `${file}\\key.asc`);
    assert.deepEqual(
      calls.map((call) => call.file),
      ["gpg"],
    );
  });

  it("converts with cygpath for the MSYS gpg and asks gpg once, without the caller's GNUPGHOME", () => {
    const { calls, runCommand } = stub("/c/gnupg", {
      status: 0,
      stdout: "/c/tmp/hardhat-kms-release-keys-x\n",
      stderr: "",
    });
    const gpgPath = gpgPathFor("cwd", env, runCommand, "win32");
    assert.equal(gpgPath(file), "/c/tmp/hardhat-kms-release-keys-x");
    gpgPath(file);
    assert.deepEqual(
      calls.map((call) => [call.file, ...call.args]),
      [
        ["gpg", "--version"],
        ["cygpath", "-u", file],
        ["cygpath", "-u", file],
      ],
    );
    assert.equal(calls[0]?.env.GNUPGHOME, undefined);
  });

  it("throws with cygpath's message when cygpath fails", () => {
    const { runCommand } = stub("/c/gnupg", { status: 1, stdout: "", stderr: "bad path\n" });
    assert.throws(() => gpgPathFor("cwd", env, runCommand, "win32")(file), {
      message: `cygpath cannot convert ${file}: bad path`,
    });
  });
});

describe("removeKeyHome", () => {
  it("refuses the temp directory, a nested path and a directory with another name", () => {
    const keep = mkdtempSync(path.join(tmpdir(), "hardhat-kms-test-keep-"));
    const other = mkdtempSync(path.join(tmpdir(), "other-"));
    const nested = path.join(keep, "hardhat-kms-release-keys-nested");
    try {
      for (const directory of [tmpdir(), other, nested, path.join(tmpdir(), "..")]) {
        assert.throws(() => removeKeyHome(directory), { message: /refusing to remove/ });
      }
      assert.equal(existsSync(keep), true);
      assert.equal(existsSync(other), true);
    } finally {
      rmSync(keep, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });
});
