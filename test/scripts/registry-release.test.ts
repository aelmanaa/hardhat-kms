// The guards of `scripts/check-registry-release.ts` (`scripts/registry-release.ts`), fed with
// recorded `npm view` and `npm audit signatures --json --include-attestations` output from
// `fixtures/registry-release/` (package names replaced). Runs in `pnpm test`, with no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertAttestations,
  assertBetaTag,
  assertGitHead,
  assertNotBelowLatest,
  assertPublished,
  compareVersions,
  type PackageView,
  parseGitHead,
  parsePackageView,
  parseVerified,
  stableVersion,
} from "../../scripts/registry-release.ts";
import { PACKAGES } from "../../scripts/registry.ts";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/registry-release",
);
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf8");

/** The four packages, each with the released fixture's dist-tags and versions. */
const released = (): PackageView[] =>
  PACKAGES.map((name) => parsePackageView(name, fixture("view-released.json")));

describe("stableVersion and compareVersions", () => {
  it("accepts major.minor.patch and refuses a prerelease and other shapes, each with its message", () => {
    assert.deepEqual(stableVersion("1.0.0"), [1, 0, 0]);
    assert.deepEqual(stableVersion("10.20.30"), [10, 20, 30]);
    assert.throws(() => stableVersion("1.0.0-beta.1"), {
      message:
        "1.0.0-beta.1 is a prerelease; only a stable major.minor.patch version goes to latest",
    });
    for (const version of ["1.0", "v1.0.0", "1.0.0+build", "latest", ""]) {
      assert.throws(() => stableVersion(version), {
        message: `${version} is not a major.minor.patch version`,
      });
    }
  });

  it("compares by number, not by string", () => {
    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
    assert.ok(compareVersions("1.10.0", "1.9.0") > 0);
    assert.ok(compareVersions("2.0.0", "1.99.99") > 0);
    assert.ok(compareVersions("1.0.9", "1.0.10") < 0);
  });
});

describe("parsePackageView", () => {
  it("reads dist-tags and versions, and a single version printed as a string", () => {
    const view = parsePackageView("hardhat-kms", fixture("view-hardhat-kms.json"));
    assert.deepEqual(view, {
      name: "hardhat-kms",
      distTags: { latest: "0.0.0", beta: "0.0.0" },
      versions: ["0.0.0"],
    });
    assert.deepEqual(
      parsePackageView("x", '{"dist-tags":{"latest":"1.0.0"},"versions":"1.0.0"}').versions,
      ["1.0.0"],
    );
  });

  it("turns npm's 404 and an empty output into an error that names the package", () => {
    assert.throws(
      () => parsePackageView("does-not-exist-hardhat-kms", fixture("view-missing.json")),
      {
        message: /^npm view does-not-exist-hardhat-kms failed: Not Found/,
      },
    );
    assert.throws(() => parsePackageView("@hardhat-kms/aws", "\n"), {
      message: "@hardhat-kms/aws has no published version",
    });
    assert.throws(() => parsePackageView("x", '{"versions":["1.0.0"]}'), {
      message: "npm view x returned no dist-tags",
    });
  });
});

describe("the release guards", () => {
  it("pass for the beta version of the released fixture", () => {
    const views = released();
    assertPublished(views, "1.0.1");
    assertBetaTag(views, "1.0.1");
    assertNotBelowLatest(views, "1.0.1");
    // The first publish: latest and beta are the same version.
    assertNotBelowLatest(views, "1.0.0");
  });

  it("refuse a version missing from any package, naming the packages", () => {
    const views = released();
    const [core, aws, ...rest] = views;
    assert.ok(core !== undefined && aws !== undefined);
    const partial = [core, { ...aws, versions: ["1.0.0"] }, ...rest];
    assert.throws(() => assertPublished(partial, "1.0.1"), {
      message: "1.0.1 is not published for @hardhat-kms/aws",
    });
    assert.throws(() => assertPublished(views, "1.0.2"), {
      message:
        "1.0.2 is not published for hardhat-kms, @hardhat-kms/aws, @hardhat-kms/gcp, @hardhat-kms/azure",
    });
  });

  it("refuse a version that beta does not point at, or no beta at all", () => {
    const views = released();
    assert.throws(() => assertBetaTag(views, "1.0.0"), {
      message: "hardhat-kms has beta at 1.0.1, not 1.0.0",
    });
    const [core, ...rest] = views;
    assert.ok(core !== undefined);
    assert.throws(
      () => assertBetaTag([{ ...core, distTags: { latest: "1.0.0" } }, ...rest], "1.0.1"),
      { message: "hardhat-kms has no beta dist-tag; release.yml publishes to beta first" },
    );
  });

  it("refuse a version below latest, and accept any version when there is no latest", () => {
    const views = released();
    assert.throws(() => assertNotBelowLatest(views, "0.9.0"), {
      message: "hardhat-kms has latest at 1.0.0; 0.9.0 is lower and would move latest backwards",
    });
    // A prerelease on latest is named as the registry's problem, not the requested version's.
    assert.throws(
      () =>
        assertNotBelowLatest(
          views.map((view) => ({ ...view, distTags: { latest: "1.0.0-rc.1", beta: "1.0.0" } })),
          "1.0.0",
        ),
      {
        message:
          "hardhat-kms has latest at 1.0.0-rc.1, which is not a stable version; fix the dist-tag first",
      },
    );
    assertNotBelowLatest(
      views.map((view) => ({ ...view, distTags: { beta: "0.9.0" } })),
      "0.9.0",
    );
  });

  it("tie the published core to the tag's commit", () => {
    const commit = "1111111111111111111111111111111111111111";
    assertGitHead(commit, commit, "1.0.1");
    assert.throws(() => assertGitHead(undefined, commit, "1.0.1"), {
      message: `hardhat-kms@1.0.1 has no gitHead in the registry, so it cannot be tied to tag v1.0.1 (${commit})`,
    });
    assert.throws(() => assertGitHead("2".repeat(40), commit, "1.0.1"), {
      message: `hardhat-kms@1.0.1 was published from ${"2".repeat(40)}, but tag v1.0.1 is ${commit}`,
    });
    assert.equal(parseGitHead(""), undefined);
    assert.equal(parseGitHead('""\n'), undefined);
    assert.equal(parseGitHead(`"${commit}"\n`), commit);
  });

  it("require a verified provenance attestation for each package at the version", () => {
    const verified = parseVerified(fixture("audit-signatures.json"));
    assert.equal(verified.length, 5);
    assert.deepEqual(verified[4], { name: "some-dependency", version: "2.0.0", provenance: false });
    assertAttestations(verified, "1.0.1");
    assert.throws(() => assertAttestations(verified, "1.0.0"), {
      message:
        "npm audit signatures verified no provenance attestation for hardhat-kms@1.0.0, @hardhat-kms/aws@1.0.0, @hardhat-kms/gcp@1.0.0, @hardhat-kms/azure@1.0.0",
    });
    // A registry signature without an attestation does not count.
    const signedOnly = verified.map((entry) =>
      entry.name === "@hardhat-kms/gcp" ? { ...entry, provenance: false } : entry,
    );
    assert.throws(() => assertAttestations(signedOnly, "1.0.1"), {
      message: "npm audit signatures verified no provenance attestation for @hardhat-kms/gcp@1.0.1",
    });
  });

  it("report npm's error from the audit output, and a missing verified list", () => {
    assert.throws(
      () =>
        parseVerified(
          '{"error":{"code":"EMISSINGSIGNATUREKEY","summary":"x has a registry signature with keyid: k but no corresponding public key can be found"}}',
        ),
      { message: /^npm audit signatures failed: x has a registry signature/ },
    );
    assert.throws(() => parseVerified('{"invalid":[],"missing":[]}'), {
      message: "npm audit signatures returned no verified list",
    });
  });
});
