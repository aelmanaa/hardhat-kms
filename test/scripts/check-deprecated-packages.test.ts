// The deprecated-package check of `pnpm run pkg:check` (`scripts/check-deprecated-packages.ts`),
// on a trimmed lockfile and `pnpm list` output: a deprecated package in a published package's
// production tree fails unless allowed, one in the development tree only is printed, and an
// allowlist entry that matches nothing fails.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALLOWED,
  classify,
  deprecatedPackages,
  productionChains,
} from "../../scripts/check-deprecated-packages.ts";

const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/deprecated-packages",
);
const lockfile = readFileSync(path.join(fixtures, "lockfile.yaml"), "utf8");
const list: unknown = JSON.parse(readFileSync(path.join(fixtures, "list.json"), "utf8"));
const NODE_DOMEXCEPTION = {
  name: "node-domexception",
  reason: "upstream",
  link: "https://example.com/1",
};

describe("deprecatedPackages", () => {
  it("reads the deprecated entries of the packages section, quoted or not", () => {
    assert.deepEqual(
      deprecatedPackages(lockfile),
      new Map([
        ["@scope/old-sdk@2.0.0", "Use @scope/new-sdk instead, it's maintained"],
        ["node-domexception@1.0.0", "Use your platform's native DOMException instead"],
        ["old-tool@1.0.0", "No longer maintained: use new-tool"],
      ]),
    );
  });

  it("reads the real lockfile", () => {
    const root = path.resolve(fixtures, "../../../..");
    const real = deprecatedPackages(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));
    assert.ok(real.has("node-domexception@1.0.0"));
  });
});

describe("productionChains", () => {
  it("walks dependencies and optional dependencies of published packages only", () => {
    assert.deepEqual(
      productionChains(list),
      new Map([
        ["google-auth-library@11.1.0", "@hardhat-kms/gcp > google-auth-library"],
        ["fetch-blob@3.2.0", "@hardhat-kms/gcp > google-auth-library > fetch-blob"],
        [
          "node-domexception@1.0.0",
          "@hardhat-kms/gcp > google-auth-library > fetch-blob > node-domexception",
        ],
        ["@scope/old-sdk@2.0.0", "@hardhat-kms/gcp > @scope/old-sdk"],
      ]),
    );
  });

  it("returns nothing for output that is not a project list", () => {
    assert.equal(productionChains({}).size, 0);
  });
});

describe("classify", () => {
  const deprecated = deprecatedPackages(lockfile);
  const production = productionChains(list);

  it("fails on a new deprecated package in a production tree, and prints the rest", () => {
    const report = classify(deprecated, production, [NODE_DOMEXCEPTION]);
    assert.deepEqual(report.problems, [
      "@scope/old-sdk@2.0.0 is deprecated and in a published package's production tree (@hardhat-kms/gcp > @scope/old-sdk): Use @scope/new-sdk instead, it's maintained. Replace or update the dependency that brings it in; if no upstream release drops it, add it to ALLOWED in scripts/check-deprecated-packages.ts with the reason and the upstream link",
    ]);
    assert.deepEqual(report.notes, [
      "node-domexception@1.0.0 is deprecated, allowed (@hardhat-kms/gcp > google-auth-library > fetch-blob > node-domexception): https://example.com/1",
      "old-tool@1.0.0 is deprecated, in the development tree only: No longer maintained: use new-tool",
    ]);
  });

  it("passes when every production entry is allowed", () => {
    const allowed = [NODE_DOMEXCEPTION, { name: "@scope/old-sdk", reason: "r", link: "l" }];
    assert.deepEqual(classify(deprecated, production, allowed).problems, []);
  });

  it("fails on a package in production that the allowlist does not name", () => {
    const report = classify(deprecated, production, []);
    assert.equal(report.problems.length, 2);
    assert.match(report.problems.join("\n"), /node-domexception@1\.0\.0 is deprecated and in/);
  });

  it("passes a deprecated package in the development tree only", () => {
    const devOnly = new Map([["old-tool@1.0.0", "gone"]]);
    assert.deepEqual(classify(devOnly, production, []), {
      problems: [],
      notes: ["old-tool@1.0.0 is deprecated, in the development tree only: gone"],
    });
  });

  it("fails on an allowlist entry that no production package needs", () => {
    const report = classify(new Map(), production, [NODE_DOMEXCEPTION]);
    assert.deepEqual(report.problems, [
      "node-domexception is in ALLOWED in scripts/check-deprecated-packages.ts, but no published package's production tree has a deprecated version of it; remove the entry",
    ]);
  });

  it("gives every allowlist entry a reason and an https link", () => {
    for (const entry of ALLOWED) {
      assert.ok(entry.reason.length > 0, entry.name);
      assert.match(entry.link, /^https:\/\/github\.com\//, entry.name);
    }
  });
});
