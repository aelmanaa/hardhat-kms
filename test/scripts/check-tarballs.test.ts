// The tarball check of release.yml (`scripts/check-tarballs.ts`): the sums listing, the manifest
// fields, and the whole check on four small tarballs built with `tar`. Runs in `pnpm test`, with
// no network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { checkManifest, checkTarballs, parseSums } from "../../scripts/check-tarballs.ts";
import { PACKAGES } from "../../scripts/registry.ts";

const COMMIT = "1111111111111111111111111111111111111111";
const VERSION = "1.2.0";
const SUM = "a".repeat(64);
const FILES = [
  "hardhat-kms-1.2.0.tgz",
  "hardhat-kms-aws-1.2.0.tgz",
  "hardhat-kms-gcp-1.2.0.tgz",
  "hardhat-kms-azure-1.2.0.tgz",
];

describe("parseSums", () => {
  it("reads four sha256sum lines in order", () => {
    const text = FILES.map((file) => `${SUM}  ${file}`).join("\n");
    assert.deepEqual(
      parseSums(`${text}\n`).map((line) => line.file),
      FILES,
    );
  });

  it("refuses a malformed line, a path and a wrong count", () => {
    assert.throws(() => parseSums(`${SUM} ${FILES[0]}\n`), { message: /^sums line 1 is not/ });
    assert.throws(() => parseSums(`${SUM}  ../x.tgz\n`), { message: /^sums line 1 is not/ });
    assert.throws(() => parseSums(`${SUM}  ${FILES[0]}\n`), {
      message: "the sums list 1 tarballs; a release has 4",
    });
  });
});

describe("checkManifest", () => {
  const expected = { name: "hardhat-kms", version: VERSION, commit: COMMIT };
  it("accepts the expected name, version and gitHead", () => {
    checkManifest("x.tgz", JSON.stringify({ ...expected, gitHead: COMMIT }), expected);
  });

  it("names the field that differs", () => {
    const good = { name: "hardhat-kms", version: VERSION, gitHead: COMMIT };
    assert.throws(
      () => checkManifest("x.tgz", JSON.stringify({ ...good, name: "other" }), expected),
      {
        message: 'x.tgz: name is "other", expected hardhat-kms',
      },
    );
    assert.throws(
      () => checkManifest("x.tgz", JSON.stringify({ ...good, version: "1.2.1" }), expected),
      {
        message: 'x.tgz: version is "1.2.1", expected 1.2.0',
      },
    );
    const { gitHead: _, ...noHead } = good;
    assert.throws(() => checkManifest("x.tgz", JSON.stringify(noHead), expected), {
      message: `x.tgz: gitHead is undefined, expected ${COMMIT}`,
    });
  });
});

describe("checkTarballs on real tarballs", () => {
  let work = "";
  let tarballs = "";
  let sums = "";

  /**
   * Packs `package/package.json` with the given manifest into `<tarballs>/<file>`. `tar` runs in
   * `work` and gets relative paths, as the script does: Git for Windows' GNU tar reads a `C:\...`
   * archive path as a remote host.
   */
  function packTarball(file: string, manifest: object): void {
    const source = mkdtempSync(path.join(work, "src-"));
    mkdirSync(path.join(source, "package"));
    writeFileSync(path.join(source, "package", "package.json"), JSON.stringify(manifest));
    execFileSync("tar", ["-czf", `tarballs/${file}`, "-C", path.basename(source), "package"], {
      cwd: work,
    });
  }

  const sha = (file: string): string =>
    createHash("sha256")
      .update(readFileSync(path.join(tarballs, file)))
      .digest("hex");

  before(() => {
    work = mkdtempSync(path.join(tmpdir(), "check-tarballs-test-"));
    tarballs = path.join(work, "tarballs");
    mkdirSync(tarballs);
    FILES.forEach((file, index) => {
      packTarball(file, { name: PACKAGES[index], version: VERSION, gitHead: COMMIT });
    });
    sums = FILES.map((file) => `${sha(file)}  ${file}`).join("\n");
  });

  after(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("passes the four tarballs the sums list", () => {
    const lines = checkTarballs(tarballs, sums, VERSION, COMMIT);
    assert.equal(lines.length, 4);
    assert.match(
      lines[0] ?? "",
      /^ok {3}hardhat-kms@1\.2\.0 gitHead 1{40} hardhat-kms-1\.2\.0\.tgz /,
    );
  });

  it("fails a tarball whose bytes differ from the recorded sum", () => {
    const swapped = sums.replace(sha(FILES[1] ?? ""), SUM);
    assert.throws(() => checkTarballs(tarballs, swapped, VERSION, COMMIT), {
      message: `hardhat-kms-aws-1.2.0.tgz: SHA-256 is ${sha(FILES[1] ?? "")}, the pack job recorded ${SUM}`,
    });
  });

  it("fails the wrong version, the wrong commit and the wrong order", () => {
    assert.throws(() => checkTarballs(tarballs, sums, "1.2.1", COMMIT), {
      message: /hardhat-kms-1\.2\.0\.tgz: version is "1\.2\.0", expected 1\.2\.1/,
    });
    assert.throws(() => checkTarballs(tarballs, sums, VERSION, "2".repeat(40)), {
      message: /hardhat-kms-1\.2\.0\.tgz: gitHead is/,
    });
    const reordered = sums.split("\n").toReversed().join("\n");
    assert.throws(() => checkTarballs(tarballs, reordered, VERSION, COMMIT), {
      message:
        /hardhat-kms-azure-1\.2\.0\.tgz: name is "@hardhat-kms\/azure", expected hardhat-kms/,
    });
  });

  it("fails a prerelease version before reading any tarball", () => {
    assert.throws(() => checkTarballs(tarballs, sums, "1.2.0-rc.1", COMMIT), {
      message: "version 1.2.0-rc.1 is not a stable X.Y.Z; a prerelease is never staged from main",
    });
  });

  it("fails a tarball the sums do not list", () => {
    packTarball("extra-1.2.0.tgz", { name: "extra", version: VERSION, gitHead: COMMIT });
    try {
      assert.throws(() => checkTarballs(tarballs, sums, VERSION, COMMIT), {
        message: /holds tarballs the sums do not list: extra-1\.2\.0\.tgz/,
      });
    } finally {
      rmSync(path.join(tarballs, "extra-1.2.0.tgz"));
    }
  });

  // GNU tar reads an archive path with a colon before its first slash as `host:path`, which is
  // how a `C:\...` path broke on Windows. The relative directory `host:dir` shows the same on
  // Linux. Windows allows no colon in a file name, so there the suite's other tests cover it.
  it(
    "reads tarballs in a relative directory whose name holds a colon",
    { skip: process.platform === "win32" ? "Windows allows no colon in a file name" : false },
    () => {
      cpSync(tarballs, path.join(work, "host:dir"), { recursive: true });
      const saved = process.cwd();
      process.chdir(work);
      try {
        assert.equal(checkTarballs("host:dir", sums, VERSION, COMMIT).length, 4);
      } finally {
        process.chdir(saved);
      }
    },
  );
});
