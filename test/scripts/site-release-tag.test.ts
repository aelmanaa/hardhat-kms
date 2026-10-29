// The tag pages.yml builds the docs site root from (`scripts/site-release-tag.ts`), from recorded
// `npm view hardhat-kms dist-tags --json` outputs. Runs in `pnpm test`, with no network.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { releaseBranchOf, siteReleaseTag, siteRootRef } from "../../scripts/site-release-tag.ts";

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

  it("builds from the branch when it adds only docs changes to the tag", () => {
    assert.deepEqual(
      siteRootRef("v1.3.0", {
        commit: COMMIT,
        descends: true,
        changed: ["docs/user/reference/tasks.md"],
      }),
      {
        ref: COMMIT,
        reason: `release/1.3 at ${COMMIT}: v1.3.0 with 1 docs file backported`,
      },
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
        "docs/user/guides/key-loss.md",
        "packages/hardhat-kms/package.json",
        ".changeset/x.md",
      ],
    });
    assert.equal(ref, "refs/tags/v1.3.0");
    assert.match(
      reason,
      /changes 2 files outside docs\/ \(packages\/hardhat-kms\/package\.json, \.changeset\/x\.md\)/,
    );
    // A path that only starts like docs/ is outside it.
    assert.equal(
      siteRootRef("v1.3.0", { commit: COMMIT, descends: true, changed: ["docs-site.md"] }).ref,
      "refs/tags/v1.3.0",
    );
  });

  it("builds from the tag when the branch does not descend from it", () => {
    assert.deepEqual(
      siteRootRef("v1.3.0", { commit: COMMIT, descends: false, changed: ["docs/README.md"] }),
      { ref: "refs/tags/v1.3.0", reason: "v1.3.0: release/1.3 does not descend from v1.3.0" },
    );
  });
});
