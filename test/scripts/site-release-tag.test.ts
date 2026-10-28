// The tag pages.yml builds the docs site root from (`scripts/site-release-tag.ts`), from recorded
// `npm view hardhat-kms dist-tags --json` outputs. Runs in `pnpm test`, with no network.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { siteReleaseTag } from "../../scripts/site-release-tag.ts";

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
