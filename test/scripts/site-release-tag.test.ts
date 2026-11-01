// The tag pages.yml builds the docs site root from (`scripts/site-release-tag.ts`), from recorded
// `npm view hardhat-kms dist-tags --json` outputs. Runs in `pnpm test`, with no network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  parseRawDiff,
  readReleaseBranch,
  releaseBranchOf,
  siteReleaseTag,
  siteRootRef,
} from "../../scripts/site-release-tag.ts";

describe("siteReleaseTag", () => {
  it("returns v and the version on latest, from npm 11's object and npm 12's array", () => {
    assert.equal(siteReleaseTag('{"latest":"1.3.0","beta":"1.3.0"}'), "v1.3.0");
    assert.equal(siteReleaseTag('[{"latest":"1.2.0","beta":"1.3.0"}]'), "v1.2.0");
    assert.equal(siteReleaseTag('{"latest":"10.0.12"}'), "v10.0.12");
  });

  for (const latest of ["1.2", "1.2.0-beta.1", "v1.2.0", "", "01.2.0", "1.2.0 ", "1.2.0\nx"]) {
    it(`refuses latest ${JSON.stringify(latest)}`, () => {
      assert.throws(
        () => siteReleaseTag(JSON.stringify({ latest })),
        /not a stable X\.Y\.Z; the site root is built only from a release/,
      );
    });
  }

  it("refuses a missing latest, and a latest that is not a string", () => {
    assert.throws(() => siteReleaseTag('{"beta":"1.3.0"}'), /latest of hardhat-kms is undefined/);
    assert.throws(() => siteReleaseTag('{"latest":130}'), /latest of hardhat-kms is 130/);
  });

  it("refuses npm's error and outputs that are not a dist-tags object", () => {
    assert.throws(
      () => siteReleaseTag('{"error":{"code":"E404","summary":"Not found"}}'),
      /not a dist-tags object/,
    );
    assert.throws(() => siteReleaseTag('"1.3.0"'), /not a dist-tags object/);
    assert.throws(() => siteReleaseTag("null"), /not a dist-tags object/);
    assert.throws(() => siteReleaseTag('[{"latest":"1.3.0"},{"latest":"1.2.0"}]'), /an array of 2/);
  });
});

/** A changed file, a regular one unless `mode` says otherwise. */
function file(name: string, mode = "100644"): { path: string; mode: string } {
  return { path: name, mode };
}

describe("siteRootRef", () => {
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";

  it("names the release branch of a tag", () => {
    assert.equal(releaseBranchOf("v1.3.0"), "release/1.3");
    assert.equal(releaseBranchOf("v10.0.12"), "release/10.0");
    assert.throws(() => releaseBranchOf("1.3.0"), /is not a vX\.Y\.Z tag/);
    assert.throws(() => releaseBranchOf("v1.3.0-next.0"), /is not a vX\.Y\.Z tag/);
  });

  it("builds from the tag when there is no release branch", () => {
    assert.deepEqual(siteRootRef("v1.3.0", { commit: undefined, descends: false, changed: [] }), {
      ref: "refs/tags/v1.3.0",
      reason: "v1.3.0: there is no release/1.3",
    });
  });

  it("builds from the branch when it adds only Markdown and images under docs/, or deletes there", () => {
    assert.deepEqual(
      siteRootRef("v1.3.0", {
        commit: COMMIT,
        descends: true,
        changed: [
          file("docs/user/reference/tasks.md"),
          file("docs/public/x.png"),
          file("docs/old.md", "000000"),
        ],
      }),
      { ref: COMMIT, reason: `release/1.3 at ${COMMIT}: v1.3.0 with 3 docs files backported` },
    );
    assert.equal(
      siteRootRef("v1.3.0", { commit: COMMIT, descends: true, changed: [] }).ref,
      COMMIT,
    );
  });

  it("builds from the tag when the branch changes anything outside docs/", () => {
    const { ref, reason } = siteRootRef("v1.3.0", {
      commit: COMMIT,
      descends: true,
      changed: [
        file("docs/user/guides/key-loss.md"),
        file("packages/hardhat-kms/package.json"),
        file(".changeset/x.md", "000000"),
      ],
    });
    assert.equal(ref, "refs/tags/v1.3.0");
    assert.match(
      reason,
      /changes 2 files outside docs\/ \("packages\/hardhat-kms\/package\.json", "\.changeset\/x\.md"\)/,
    );
    // A path that only starts like docs/ is outside it.
    assert.equal(
      siteRootRef("v1.3.0", { commit: COMMIT, descends: true, changed: [file("docs-site.md")] })
        .ref,
      "refs/tags/v1.3.0",
    );
  });

  it("builds from the tag when a file under docs/ could run: code, a symlink, an executable", () => {
    for (const changed of [
      file("docs/Widget.vue"),
      file("docs/data.data.ts"),
      file("docs/public/x.html"),
      file("docs/link.md", "120000"),
      file("docs/run.md", "100755"),
      file("docs/sub", "160000"),
    ]) {
      const { ref, reason } = siteRootRef("v1.3.0", {
        commit: COMMIT,
        descends: true,
        changed: [changed],
      });
      assert.equal(ref, "refs/tags/v1.3.0", changed.path);
      assert.match(reason, /not a regular Markdown or image file/);
    }
  });

  it("builds from the tag when the branch does not descend from it", () => {
    assert.deepEqual(
      siteRootRef("v1.3.0", { commit: COMMIT, descends: false, changed: [file("docs/README.md")] }),
      { ref: "refs/tags/v1.3.0", reason: "v1.3.0: release/1.3 does not descend from v1.3.0" },
    );
  });
});

describe("parseRawDiff", () => {
  it("reads each entry's new mode and path, as git prints them with -z", () => {
    const raw = ":100644 100644 aaa bbb M\0docs/é.md\0:100644 000000 aaa 000 D\0tools/x.ts\0";
    assert.deepEqual(parseRawDiff(raw), [
      { path: "docs/é.md", mode: "100644" },
      { path: "tools/x.ts", mode: "000000" },
    ]);
    assert.deepEqual(parseRawDiff(""), []);
    assert.throws(() => parseRawDiff("docs/x.md\0"), /an entry it should not/);
  });
});

/** A repository with a v1.3.0 tag and, after `branch`, a remote-tracking release/1.3. */
function repository(branch: (git: (...args: string[]) => string) => void): string {
  const dir = mkdtempSync(path.join(tmpdir(), "site-release-tag-"));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        ...args,
      ],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );
  git("init", "--quiet", "--initial-branch=main");
  mkdirSync(path.join(dir, "docs"));
  mkdirSync(path.join(dir, "tools"));
  writeFileSync(path.join(dir, "docs", "a.md"), "a\n");
  writeFileSync(path.join(dir, "tools", "config.ts"), "export {};\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "release");
  git("tag", "v1.3.0");
  branch(git);
  git("update-ref", "refs/remotes/origin/release/1.3", "HEAD");
  return dir;
}

describe("readReleaseBranch", () => {
  it("reads a docs fix, a path that is not ASCII, and a missing branch", () => {
    const dir = repository((git) => {
      writeFileSync(path.join(dir0(git), "docs", "é.md"), "é\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "fix");
    });
    const branch = readReleaseBranch("v1.3.0", dir);
    assert.equal(branch.descends, true);
    assert.deepEqual(branch.changed, [{ path: "docs/é.md", mode: "100644" }]);
    assert.equal(siteRootRef("v1.3.0", branch).ref, branch.commit);
    assert.deepEqual(readReleaseBranch("v1.4.0", dir), {
      commit: undefined,
      descends: false,
      changed: [],
    });
  });

  it("sees a file moved into docs/ as a deletion outside it", () => {
    const dir = repository((git) => {
      git("mv", "tools/config.ts", "docs/config.ts");
      git("commit", "--quiet", "-m", "move");
    });
    const branch = readReleaseBranch("v1.3.0", dir);
    assert.deepEqual(branch.changed.map((changed) => changed.path).toSorted(), [
      "docs/config.ts",
      "tools/config.ts",
    ]);
    assert.equal(siteRootRef("v1.3.0", branch).ref, "refs/tags/v1.3.0");
  });

  it("sees a branch that does not descend from the tag", () => {
    const dir = repository((git) => {
      git("checkout", "--quiet", "--orphan", "other");
      git("commit", "--quiet", "-m", "unrelated");
    });
    const branch = readReleaseBranch("v1.3.0", dir);
    assert.equal(branch.descends, false);
    assert.equal(siteRootRef("v1.3.0", branch).ref, "refs/tags/v1.3.0");
  });
});

/** The working directory of a repository's git helper. */
function dir0(git: (...args: string[]) => string): string {
  return git("rev-parse", "--show-toplevel").trim();
}
