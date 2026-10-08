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
  assertStagedTag,
  assertGitHead,
  assertNotBelowLatest,
  assertPublished,
  bumpOf,
  checkLiveRule,
  compareVersions,
  type PackageView,
  parseGitHead,
  parseLiveRun,
  parsePackageView,
  parseVerified,
  stableVersion,
  stagingDistTags,
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
    assertStagedTag(views, "1.0.1");
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
    assert.throws(() => assertStagedTag(views, "1.0.0"), {
      message:
        "hardhat-kms has beta at 1.0.1, release-1.0 at nothing, not 1.0.0; release.yml stages a version under beta or release-1.0 first",
    });
    const [core, ...rest] = views;
    assert.ok(core !== undefined);
    assert.throws(
      () => assertStagedTag([{ ...core, distTags: { latest: "1.0.0" } }, ...rest], "1.0.1"),
      {
        message:
          "hardhat-kms has beta at nothing, release-1.0 at nothing, not 1.0.1; release.yml stages a version under beta or release-1.0 first",
      },
    );
  });

  it("accept a hotfix staged under the release-X.Y dist-tag of its own line only", () => {
    // 1.2.0 is the newest release, on beta and latest; 1.0.1 is a hotfix of the 1.0 line.
    const hotfix = released().map((view) => ({
      ...view,
      distTags: { latest: "1.2.0", beta: "1.2.0", "release-1.0": "1.0.1", "release-1.1": "1.1.4" },
      versions: [...view.versions, "1.0.1", "1.1.4", "1.2.0"],
    }));
    assertStagedTag(hotfix, "1.0.1");
    assertStagedTag(hotfix, "1.1.4");
    assert.deepEqual(stagingDistTags("1.0.1"), ["beta", "release-1.0"]);
    // Another line's dist-tag does not count: 1.1.4 is not on release-1.0's line.
    const crossed = hotfix.map((view) => ({
      ...view,
      distTags: { latest: "1.2.0", beta: "1.2.0", "release-1.0": "1.1.4" },
    }));
    assert.throws(() => assertStagedTag(crossed, "1.1.4"), {
      message:
        "hardhat-kms has beta at 1.2.0, release-1.1 at nothing, not 1.1.4; release.yml stages a version under beta or release-1.1 first",
    });
    // A hotfix of an older line never goes to latest: latest would move backwards.
    assert.throws(() => assertNotBelowLatest(hotfix, "1.0.1"), {
      message: "hardhat-kms has latest at 1.2.0; 1.0.1 is lower and would move latest backwards",
    });
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

describe("the live rule of promote.yml", () => {
  const sepolia = parseLiveRun("sepolia:0123abc");

  it("parses sepolia:<commit>, fork and none, and refuses anything else", () => {
    assert.deepEqual(sepolia, { kind: "sepolia", commit: "0123abc" });
    assert.deepEqual(parseLiveRun("fork"), { kind: "fork" });
    assert.deepEqual(parseLiveRun("none"), { kind: "none" });
    for (const value of [
      "sepolia:",
      "sepolia:XYZ1234",
      "sepolia:abc",
      "Sepolia:0123abc",
      "sepolia:xyz0123abc",
      "sepolia:0123abc/",
      "sepolia:0123abc\nfork",
      "fork\n",
      "",
    ]) {
      assert.throws(() => parseLiveRun(value), {
        message: `live-run ${JSON.stringify(value)} is not sepolia:<commit>, fork or none; the commit is the one that added test/live/proof.json`,
      });
    }
  });

  it("reads the bump from the version numbers", () => {
    assert.equal(bumpOf("1.2.3"), "patch");
    assert.equal(bumpOf("0.9.1"), "patch");
    assert.equal(bumpOf("1.2.0"), "minor");
    assert.equal(bumpOf("0.9.0"), "minor");
    assert.equal(bumpOf("1.0.0"), "major");
    assert.throws(() => bumpOf("1.0.0-beta.1"), { message: /is a prerelease/ });
  });

  it("accepts any value on a patch, and says the signing call is the maintainer's", () => {
    for (const value of [sepolia, parseLiveRun("fork"), parseLiveRun("none")]) {
      for (const target of ["verify", "latest"] as const) {
        assert.match(checkLiveRule("1.2.3", target, value), /^1\.2\.3 is a patch; live-run /);
      }
    }
  });

  it("refuses none on a minor or a major, for both targets", () => {
    for (const target of ["verify", "latest"] as const) {
      assert.throws(() => checkLiveRule("1.2.0", target, { kind: "none" }), {
        message:
          /^1\.2\.0 is a minor; live-run none is refused for a minor or a major\. Run the live suite/,
      });
      assert.throws(() => checkLiveRule("2.0.0", target, { kind: "none" }), {
        message:
          /^2\.0\.0 is a major; live-run none is refused for a minor or a major\. Run the live suite/,
      });
    }
  });

  it("moves latest on a minor or a major only with a Sepolia run", () => {
    assert.throws(() => checkLiveRule("1.2.0", "latest", { kind: "fork" }), {
      message:
        /^1\.2\.0 is a minor; moving latest needs live-run sepolia:<commit>, not fork\. Run the Sepolia suite/,
    });
    assert.equal(
      checkLiveRule("1.2.0", "verify", { kind: "fork" }),
      "1.2.0 is a minor; live-run fork meets the live rule for target verify.",
    );
    assert.equal(
      checkLiveRule("2.0.0", "latest", sepolia),
      "2.0.0 is a major; live-run sepolia at 0123abc meets the live rule for target latest.",
    );
  });
});
