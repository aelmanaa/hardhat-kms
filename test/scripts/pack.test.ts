// The per-run pack directory of `scripts/pack.ts`. Runs in `pnpm test` and never calls `pnpm pack`.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { removePackDirectory, withPackDirectory } from "../../scripts/pack.ts";

describe("withPackDirectory", () => {
  // The helper removes directories recursively, so the tests point it at a temp directory of their
  // own: a failing assertion or a wrong edit to the helper then cannot touch the real one.
  const realTmpdir = process.env.TMPDIR;
  let sandbox = "";
  before(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), "hardhat-kms-pack-test-"));
    process.env.TMPDIR = sandbox;
    assert.equal(path.resolve(tmpdir()), path.resolve(sandbox));
  });
  after(() => {
    if (realTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = realTmpdir;
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("gives two overlapping calls different directories under the temp directory", () => {
    const [first, second] = withPackDirectory((outer) =>
      withPackDirectory((inner) => {
        assert.equal(statSync(outer).isDirectory(), true);
        assert.equal(statSync(inner).isDirectory(), true);
        return [outer, inner];
      }),
    );
    assert.notEqual(first, second);
    for (const directory of [first, second]) {
      assert.notEqual(path.resolve(directory), path.resolve(sandbox));
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(sandbox));
    }
    assert.equal(existsSync(sandbox), true);
  });

  it("removes the directory and its files when the callback returns", () => {
    const directory = withPackDirectory((created) => {
      writeFileSync(path.join(created, "hardhat-kms-0.0.0.tgz"), "");
      return created;
    });
    assert.equal(existsSync(directory), false);
  });

  it("removes the directory when the callback throws, and rethrows", () => {
    let directory = "";
    assert.throws(
      () =>
        withPackDirectory((created) => {
          directory = created;
          writeFileSync(path.join(created, "hardhat-kms-0.0.0.tgz"), "");
          throw new Error("attw failed");
        }),
      { message: "attw failed" },
    );
    assert.notEqual(directory, "");
    assert.equal(existsSync(directory), false);
  });
});

describe("removePackDirectory", () => {
  it("refuses the temp directory, a nested path and a directory with another name", () => {
    const keep = mkdtempSync(path.join(tmpdir(), "hardhat-kms-pack-test-keep-"));
    const other = mkdtempSync(path.join(tmpdir(), "other-"));
    const nested = path.join(keep, "hardhat-kms-pack-nested");
    try {
      for (const directory of [tmpdir(), other, nested, path.join(tmpdir(), "..")]) {
        assert.throws(() => removePackDirectory(directory), { message: /refusing to remove/ });
      }
      assert.equal(existsSync(keep), true);
      assert.equal(existsSync(other), true);
      assert.equal(existsSync(tmpdir()), true);
    } finally {
      rmSync(keep, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });
});
