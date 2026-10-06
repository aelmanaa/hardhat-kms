// The release tag checks of `scripts/verify-release-tag.ts`, against a temporary repository with
// a bare `origin`, and tags signed by temporary keys under temporary GNUPGHOMEs. Skipped when `gpg`
// is absent. Runs in `pnpm test`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MANIFESTS,
  importedFingerprints,
  readSignature,
  removeKeyHome,
  verifyReleaseTag,
} from "../../scripts/verify-release-tag.ts";

const script = fileURLToPath(new URL("../../scripts/verify-release-tag.ts", import.meta.url));
const hasGpg = spawnSync("gpg", ["--version"]).status === 0;

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

/** A key pair in its own GNUPGHOME; the home's path is short so the agent socket fits. */
function generateKey(home: string, name: string, env: NodeJS.ProcessEnv): string {
  mkdirSync(home, { mode: 0o700 });
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
    home,
    env,
  );
  const listed = mustRun(
    "gpg",
    ["--batch", "--homedir", home, "--with-colons", "--list-keys"],
    home,
    env,
  );
  const fingerprint = /^fpr:+([0-9A-F]+):/m.exec(listed)?.[1];
  assert.notEqual(fingerprint, undefined);
  return fingerprint ?? "";
}

function stopAgent(home: string, env: NodeJS.ProcessEnv): void {
  spawnSync("gpgconf", ["--homedir", home, "--kill", "gpg-agent"], { env });
}

describe("verify-release-tag", { skip: hasGpg ? false : "gpg is not installed" }, () => {
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
  const verify = (tag: string, options: { keysDirectory?: string; mainRef?: string } = {}) =>
    verifyReleaseTag({ tag, cwd: repo, env, keysDirectory: keys, ...options });
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

    trustedHome = path.join(sandbox, "g1");
    otherHome = path.join(sandbox, "g2");
    trustedKey = generateKey(trustedHome, "Release Maintainer", env);
    otherKey = generateKey(otherHome, "Someone Else", env);
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
          reason: "tag v1.2.3 is annotated but has no OpenPGP signature",
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
          reason: `${file} contains a private key; only public keys belong there`,
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
            reason: "version 2.0.0-next.1 is a prerelease; only stable versions release from main",
          }),
      );
    } finally {
      git(["checkout", "--quiet", "main"]);
      git(["branch", "--quiet", "-D", "prerelease"]);
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
            reason: `commit ${commit} of v1.2.3 is not on origin/main`,
          }),
      );
    } finally {
      git(["checkout", "--quiet", "main"]);
      git(["branch", "--quiet", "-D", "unmerged"]);
    }
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

  it("exits 0 from the command line on a good tag and 1 with the reason on a bad one", () => {
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
        const passed = run(process.execPath, [script, "v1.2.3", "--keys", keys], repo, cliEnv);
        assert.equal(passed.status, 0, passed.stderr);
        assert.match(
          passed.stdout,
          /^v1\.2\.3 passes: signed by Release Maintainer <[^>]+> \([0-9A-F]+\), version 1\.2\.3 in 4 manifests, commit [0-9a-f]{40} on origin\/main\n$/,
        );
        const failed = run(
          process.execPath,
          [script, "v1.2.3", "--keys", path.join(sandbox, "no-keys")],
          repo,
          cliEnv,
        );
        assert.equal(failed.status, 1);
        assert.match(failed.stderr, /^v1\.2\.3 fails: no release keys: /);
      },
    );
    const usage = run(process.execPath, [script], repo, cliEnv);
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /^usage: /);
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
      reason: "the signature does not match the tag (key 0000AAAA0000AAAA)",
    });
    assert.deepEqual(readSignature(["EXPKEYSIG 0000AAAA0000AAAA Someone", ...valid], trusted), {
      ok: false,
      reason: "the signing key 0000AAAA0000AAAA is expired",
    });
    assert.deepEqual(readSignature(["REVKEYSIG 0000AAAA0000AAAA Someone", ...valid], trusted), {
      ok: false,
      reason: "the signing key 0000AAAA0000AAAA is revoked",
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
      reason: "gpg reported no valid signature on the tag",
    });
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
