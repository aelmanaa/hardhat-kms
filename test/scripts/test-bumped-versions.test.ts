// scripts/test-bumped-versions.ts and the ci.yml job that runs it. Runs in `pnpm test`, with no
// network; the script itself runs `pnpm test`, so it is exercised by CI, not here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import {
  offlineConfig,
  pendingChangesets,
  versionChanges,
} from "../../scripts/test-bumped-versions.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

describe("pendingChangesets", () => {
  it("keeps the Markdown files directly under .changeset/ but the README, sorted", () => {
    assert.deepEqual(
      pendingChangesets([
        ".changeset/README.md",
        ".changeset/config.json",
        ".changeset/zebra-fix.md",
        ".changeset/alpha-feature.md",
      ]),
      [".changeset/alpha-feature.md", ".changeset/zebra-fix.md"],
    );
  });

  it("finds none in a tree with only the README and the config", () => {
    assert.deepEqual(pendingChangesets([".changeset/README.md", ".changeset/config.json"]), []);
  });
});

describe("offlineConfig", () => {
  it("turns the changelog off and keeps the rest of the repository's config", () => {
    const text = readFileSync(path.join(ROOT, ".changeset/config.json"), "utf8");
    const original: unknown = JSON.parse(text);
    const offline: unknown = JSON.parse(offlineConfig(text));
    assert.notEqual(field(original, "changelog"), false);
    assert.equal(field(offline, "changelog"), false);
    assert.deepEqual({ ...Object(offline), changelog: field(original, "changelog") }, original);
  });

  it("refuses a config that is not a JSON object", () => {
    assert.throws(() => offlineConfig("[]"), /not a JSON object/);
    assert.throws(() => offlineConfig("null"), /not a JSON object/);
  });
});

describe("versionChanges", () => {
  it("lists only the packages whose version changed", () => {
    const before = new Map([
      ["hardhat-kms", "1.2.0"],
      ["@hardhat-kms/aws", "1.2.0"],
    ]);
    assert.deepEqual(
      versionChanges(
        before,
        new Map([
          ["hardhat-kms", "1.3.0"],
          ["@hardhat-kms/aws", "1.2.0"],
        ]),
      ),
      ["hardhat-kms 1.2.0 -> 1.3.0"],
    );
    assert.deepEqual(versionChanges(before, before), []);
  });
});

describe("the bumped job of ci.yml", () => {
  const workflow: unknown = parse(
    readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8"),
  );
  const job = field(field(workflow, "jobs"), "bumped");
  const steps = field(job, "steps");
  const stepList: unknown[] = Array.isArray(steps) ? steps : [];

  it("runs on pull requests and on pushes to main, with a read-only token", () => {
    const on = field(workflow, "on");
    assert.ok(typeof on === "object" && on !== null && Object.hasOwn(on, "pull_request"));
    assert.deepEqual(field(field(on, "push"), "branches"), ["main"]);
    assert.deepEqual(field(workflow, "permissions"), { contents: "read" });
    assert.equal(field(job, "permissions"), undefined);
    assert.equal(field(job, "if"), undefined);
  });

  it("runs the script and restores no cache", () => {
    assert.ok(
      stepList.some((step) => field(step, "run") === "node scripts/test-bumped-versions.ts"),
    );
    for (const step of stepList) {
      const uses = asString(field(step, "uses"));
      assert.ok(!uses.startsWith("actions/cache"), uses);
      if (uses.startsWith("actions/setup-node@")) {
        assert.equal(field(field(step, "with"), "package-manager-cache"), false);
        assert.equal(field(field(step, "with"), "cache"), undefined);
      }
    }
  });

  it("checks out without persisting credentials and passes no secret", () => {
    const checkout = stepList.find((step) =>
      asString(field(step, "uses")).startsWith("actions/checkout@"),
    );
    assert.equal(field(field(checkout, "with"), "persist-credentials"), false);
    assert.doesNotMatch(JSON.stringify(job), /secrets\.|github\.token|GITHUB_TOKEN/);
  });
});
