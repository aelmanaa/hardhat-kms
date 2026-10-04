// The per-run pack directory of `scripts/pack.ts`. Runs in `pnpm test`; it packs nothing.
import assert from "node:assert/strict";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { withPackDirectory } from "../../scripts/pack.ts";

describe("withPackDirectory", () => {
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
      assert.notEqual(path.resolve(directory), path.resolve(tmpdir()));
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    }
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
