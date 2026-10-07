// The fresh-install deprecation check (`scripts/check-fresh-install.ts`) without installing: the
// production-tree walk on node_modules layouts built here (npm's hoisted one with a nested copy,
// pnpm's symlinked one), the registry answers from a recorded google-gax document, and the
// classification against ALLOWED. A tree with google-gax 6.11.0 fails; the same tree with 6.10.0
// passes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyFresh,
  deprecatedVersions,
  productionTree,
  registryDeprecations,
} from "../../scripts/check-fresh-install.ts";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fresh-install");
/** The abbreviated registry document of google-gax, trimmed to 6.10.0 and 6.11.0 (2026-10-07). */
const googleGax: unknown = JSON.parse(readFileSync(path.join(fixtures, "google-gax.json"), "utf8"));
const NODE_DOMEXCEPTION_MESSAGE = "Use your platform's native DOMException instead";
/** What the fake registry answers, by package name. */
const REGISTRY: Record<string, unknown> = {
  "google-gax": googleGax,
  "@google-cloud/kms": { versions: { "6.2.1": {} } },
  "node-domexception": { versions: { "1.0.0": { deprecated: NODE_DOMEXCEPTION_MESSAGE } } },
  "fetch-blob": { versions: { "3.2.0": { deprecated: "" } } },
  "left-pad": { versions: { "1.3.0": { deprecated: "use String.prototype.padStart()" } } },
};
const ALLOWED = [{ name: "node-domexception", reason: "upstream", link: "https://example.com/1" }];

const work = mkdtempSync(path.join(tmpdir(), "hardhat-kms-fresh-install-test-"));
after(() => rmSync(work, { recursive: true, force: true }));

/** Writes a package.json into `directory`. */
function writePackage(
  directory: string,
  name: string,
  version: string,
  fields: Record<string, Record<string, string>> = {},
): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name, version, ...fields }, null, 2),
  );
}

/**
 * npm's layout: one google-gax hoisted, a second one nested under @google-cloud/kms (as Yarn
 * classic installs it), a peer that is installed but not followed, and an optional dependency for
 * another platform that is not installed.
 */
function hoistedProject(gaxVersion: string, nestedVersion: string): string {
  const project = mkdtempSync(path.join(work, "hoisted-"));
  const modules = path.join(project, "node_modules");
  writePackage(project, "project", "1.0.0", {
    dependencies: { "hardhat-kms": "1.0.0", "@hardhat-kms/gcp": "1.0.0" },
  });
  writePackage(path.join(modules, "hardhat-kms"), "hardhat-kms", "1.0.0", {
    peerDependencies: { hardhat: "^3.0.0" },
  });
  writePackage(path.join(modules, "hardhat"), "hardhat", "3.0.0", {
    dependencies: { "left-pad": "^1.3.0" },
  });
  writePackage(path.join(modules, "left-pad"), "left-pad", "1.3.0");
  writePackage(path.join(modules, "@hardhat-kms", "gcp"), "@hardhat-kms/gcp", "1.0.0", {
    dependencies: { "@google-cloud/kms": "^6.2.1", "google-gax": "^6.5.0 <6.11.0 || ^6.11.1" },
    optionalDependencies: { "fsevents-for-another-platform": "^1.0.0" },
    peerDependencies: { "hardhat-kms": "1.0.0" },
  });
  writePackage(path.join(modules, "@google-cloud", "kms"), "@google-cloud/kms", "6.2.1", {
    dependencies: { "google-gax": "^6.0.0" },
  });
  writePackage(
    path.join(modules, "@google-cloud", "kms", "node_modules", "google-gax"),
    "google-gax",
    nestedVersion,
  );
  writePackage(path.join(modules, "google-gax"), "google-gax", gaxVersion, {
    dependencies: { "node-domexception": "^1.0.0" },
  });
  writePackage(path.join(modules, "node-domexception"), "node-domexception", "1.0.0");
  return project;
}

/** Links `at` to `target`, as pnpm links a package into node_modules. */
function link(target: string, at: string): void {
  mkdirSync(path.dirname(at), { recursive: true });
  // A junction needs no rights on Windows; other platforms ignore the type.
  symlinkSync(target, at, "junction");
}

/** pnpm's layout: symlinks into node_modules/.pnpm, each package's dependencies next to it. */
function pnpmProject(): string {
  const project = mkdtempSync(path.join(work, "pnpm-"));
  const store = path.join(project, "node_modules", ".pnpm");
  const real = (key: string, name: string): string =>
    path.join(store, key, "node_modules", ...name.split("/"));
  writePackage(real("@hardhat-kms+gcp@1.0.0", "@hardhat-kms/gcp"), "@hardhat-kms/gcp", "1.0.0", {
    dependencies: { "google-gax": "^6.5.0 <6.11.0 || ^6.11.1" },
  });
  writePackage(real("hardhat-kms@1.0.0", "hardhat-kms"), "hardhat-kms", "1.0.0");
  writePackage(real("google-gax@6.10.0", "google-gax"), "google-gax", "6.10.0");
  link(
    real("google-gax@6.10.0", "google-gax"),
    path.join(store, "@hardhat-kms+gcp@1.0.0", "node_modules", "google-gax"),
  );
  link(
    real("@hardhat-kms+gcp@1.0.0", "@hardhat-kms/gcp"),
    path.join(project, "node_modules", "@hardhat-kms", "gcp"),
  );
  link(real("hardhat-kms@1.0.0", "hardhat-kms"), path.join(project, "node_modules", "hardhat-kms"));
  return project;
}

async function fakeRegistry(name: string): Promise<unknown> {
  const document = REGISTRY[name];
  if (document === undefined) {
    throw new Error(`no recorded answer for ${name}`);
  }
  return await Promise.resolve(document);
}

/** Runs the check on a project with the recorded registry answers and the test's ALLOWED. */
async function check(project: string): Promise<ReturnType<typeof classifyFresh>> {
  const tree = productionTree(project, ["hardhat-kms", "@hardhat-kms/gcp"]);
  const deprecated = await registryDeprecations(tree.keys(), fakeRegistry);
  return classifyFresh("@hardhat-kms/gcp with npm", tree, deprecated, ALLOWED);
}

describe("productionTree", () => {
  it("walks dependencies and optional ones, nested copies included, and not peers", () => {
    const tree = productionTree(hoistedProject("6.10.0", "6.11.0"), [
      "hardhat-kms",
      "@hardhat-kms/gcp",
    ]);
    assert.deepEqual(
      new Map([...tree].toSorted(([a], [b]) => a.localeCompare(b))),
      new Map([
        ["@google-cloud/kms@6.2.1", "@hardhat-kms/gcp > @google-cloud/kms"],
        ["google-gax@6.10.0", "@hardhat-kms/gcp > google-gax"],
        ["google-gax@6.11.0", "@hardhat-kms/gcp > @google-cloud/kms > google-gax"],
        ["node-domexception@1.0.0", "@hardhat-kms/gcp > google-gax > node-domexception"],
      ]),
    );
  });

  it("follows pnpm's symlinks to each package's own dependencies", () => {
    const tree = productionTree(pnpmProject(), ["hardhat-kms", "@hardhat-kms/gcp"]);
    assert.deepEqual(tree, new Map([["google-gax@6.10.0", "@hardhat-kms/gcp > google-gax"]]));
  });

  it("does not look for a package above the project", () => {
    const project = hoistedProject("6.10.0", "6.10.0");
    rmSync(path.join(project, "node_modules", "left-pad"), { recursive: true });
    // A copy one level up, where Node would still find it.
    writePackage(path.join(path.dirname(project), "node_modules", "left-pad"), "left-pad", "1.3.0");
    const nested = path.join(project, "node_modules", "@hardhat-kms", "gcp");
    writePackage(nested, "@hardhat-kms/gcp", "1.0.0", { dependencies: { "left-pad": "^1.3.0" } });
    assert.throws(
      () => productionTree(project, ["@hardhat-kms/gcp"]),
      /@hardhat-kms\/gcp depends on left-pad, which is not installed/,
    );
  });

  it("throws when a regular dependency or a root is not installed", () => {
    const project = hoistedProject("6.10.0", "6.10.0");
    rmSync(path.join(project, "node_modules", "node-domexception"), { recursive: true });
    assert.throws(
      () => productionTree(project, ["@hardhat-kms/gcp"]),
      /google-gax depends on node-domexception, which is not installed/,
    );
    assert.throws(() => productionTree(project, ["@hardhat-kms/aws"]), /not installed/);
  });
});

describe("deprecatedVersions", () => {
  it("reads the deprecated versions of a recorded registry document", () => {
    assert.deepEqual(
      deprecatedVersions(googleGax),
      new Map([
        [
          "6.11.0",
          "Version 6.11.0 has been deprecated due to a known bug. Please use a previous patch version or the next version if available.",
        ],
      ]),
    );
  });

  it("treats an empty message as not deprecated, and rejects a document without versions", () => {
    assert.deepEqual(deprecatedVersions(REGISTRY["fetch-blob"]), new Map());
    assert.throws(() => deprecatedVersions({ error: "not found" }), /no versions/);
  });
});

describe("registryDeprecations", () => {
  it("asks once per name and returns the deprecated keys", async () => {
    const asked: string[] = [];
    const found = await registryDeprecations(
      ["google-gax@6.10.0", "google-gax@6.11.0", "node-domexception@1.0.0", "fetch-blob@3.2.0"],
      async (name) => {
        asked.push(name);
        return await fakeRegistry(name);
      },
    );
    assert.deepEqual(asked.toSorted(), ["fetch-blob", "google-gax", "node-domexception"]);
    assert.deepEqual([...found.keys()].toSorted(), [
      "google-gax@6.11.0",
      "node-domexception@1.0.0",
    ]);
  });

  it("fails when the registry does not list an installed version", async () => {
    await assert.rejects(
      registryDeprecations(["google-gax@6.11.1"], fakeRegistry),
      /the registry lists no google-gax@6\.11\.1/,
    );
  });

  it("fails when a registry request fails", async () => {
    await assert.rejects(registryDeprecations(["unknown-package@1.0.0"], fakeRegistry), /unknown/);
  });
});

describe("classifyFresh", () => {
  it("fails on a deprecated google-gax anywhere in the tree, and allows node-domexception", async () => {
    for (const project of [
      hoistedProject("6.10.0", "6.11.0"),
      hoistedProject("6.11.0", "6.10.0"),
    ]) {
      const report = await check(project);
      assert.equal(report.problems.length, 1);
      assert.match(
        report.problems[0] ?? "",
        /^@hardhat-kms\/gcp with npm: google-gax@6\.11\.0 is deprecated \(@hardhat-kms\/gcp > .*google-gax\): Version 6\.11\.0 has been deprecated due to a known bug/,
      );
      assert.deepEqual(report.notes, [
        "@hardhat-kms/gcp with npm: node-domexception@1.0.0 is deprecated, allowed (@hardhat-kms/gcp > google-gax > node-domexception): https://example.com/1",
      ]);
    }
  });

  it("passes when every google-gax is 6.10.0", async () => {
    const report = await check(hoistedProject("6.10.0", "6.10.0"));
    assert.deepEqual(report.problems, []);
    assert.equal(report.notes.length, 1);
  });

  it("fails on node-domexception when ALLOWED does not list it", () => {
    const tree = new Map([["node-domexception@1.0.0", "@hardhat-kms/gcp > node-domexception"]]);
    const deprecated = new Map([["node-domexception@1.0.0", NODE_DOMEXCEPTION_MESSAGE]]);
    const report = classifyFresh("@hardhat-kms/gcp with pnpm", tree, deprecated, []);
    assert.equal(report.problems.length, 1);
    assert.match(report.problems[0] ?? "", /add it to ALLOWED/);
  });
});
