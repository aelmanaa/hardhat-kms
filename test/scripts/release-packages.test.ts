// The release package list (scripts/release-packages.ts): derived from the workspace, equal to
// every published packages/*/package.json, the changesets fixed group and what the release
// workflows loop over, and the npm-name check of the publish job (scripts/check-npm-names.ts).
// Runs in `pnpm test`, with no network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { missingMessage, parseNameView } from "../../scripts/check-npm-names.ts";
import {
  CORE,
  PACKAGES,
  RELEASE_PACKAGES,
  releasePackagesAt,
  releasePackagesFrom,
} from "../../scripts/release-packages.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOWS = path.join(ROOT, ".github/workflows");

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

/**
 * The published packages, read here without the script: each directory under packages/ whose
 * package.json does not say `"private": true`.
 */
function publishedInWorkspace(): Map<string, string> {
  const published = new Map<string, string>();
  for (const entry of readdirSync(path.join(ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(ROOT, "packages", entry.name, "package.json"), "utf8"),
    );
    if (field(manifest, "private") !== true) {
      published.set(String(field(manifest, "name")), entry.name);
    }
  }
  return published;
}

describe("the release package list", () => {
  it("has every published workspace package and names none that does not exist", () => {
    const published = publishedInWorkspace();
    const missing = [...published.keys()].filter((name) => !PACKAGES.includes(name));
    const unknown = PACKAGES.filter((name) => !published.has(name));
    assert.deepEqual(missing, [], "published workspace packages missing from the release list");
    assert.deepEqual(unknown, [], "release packages with no published workspace manifest");
    for (const entry of RELEASE_PACKAGES) {
      assert.equal(published.get(entry.name), entry.directory, entry.name);
    }
  });

  it("is the five packages, Turnkey included, with the core first", () => {
    assert.deepEqual(PACKAGES, [
      "hardhat-kms",
      "@hardhat-kms/aws",
      "@hardhat-kms/azure",
      "@hardhat-kms/gcp",
      "@hardhat-kms/turnkey",
    ]);
    assert.equal(PACKAGES[0], CORE);
  });

  it("equals the changesets fixed group, which versions them together", () => {
    const config: unknown = JSON.parse(
      readFileSync(path.join(ROOT, ".changeset/config.json"), "utf8"),
    );
    const fixed = field(config, "fixed");
    assert.ok(Array.isArray(fixed));
    assert.equal(fixed.length, 1);
    const group: unknown = fixed[0];
    assert.ok(Array.isArray(group));
    assert.equal(group.length, PACKAGES.length);
    assert.deepEqual(new Set(group), new Set(PACKAGES));
  });

  it("is the only package list in the release workflows' loops", () => {
    const found: string[] = [];
    for (const file of readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml"))) {
      const text = readFileSync(path.join(WORKFLOWS, file), "utf8");
      for (const match of text.matchAll(/^\s*for \w+ in ([^;\n]*)/gm)) {
        if (/hardhat-kms/.test(match[1] ?? "")) {
          found.push(`${file}: ${match[0].trim()}`);
        }
      }
    }
    assert.deepEqual(found, []);
  });

  it("is what release-stage.yml packs", () => {
    const workflow: unknown = parse(
      readFileSync(path.join(WORKFLOWS, "release-stage.yml"), "utf8"),
    );
    const steps = field(field(field(workflow, "jobs"), "pack"), "steps");
    assert.ok(Array.isArray(steps));
    const pack: unknown = steps.find((step: unknown) => field(step, "id") === "pack");
    const run = String(field(pack, "run"));
    assert.match(run, /dirs="\$\(node scripts\/release-packages\.ts --directories\)"/);
    assert.match(run, /for dir in \$dirs; do/);
  });
});

/** A package.json with a name and any other fields. */
const manifest = (name: string, extra: object = {}): object => ({ name, ...extra });

/** A `git` that lists one package directory whose manifest it cannot show. */
const gap = (args: readonly string[]) =>
  args[0] === "ls-tree" ? { status: 0, stdout: "empty\n" } : { status: 128, stdout: "" };

/** A `git` that lists one package directory whose manifest is not JSON. */
const broken = (args: readonly string[]) =>
  args[0] === "ls-tree" ? { status: 0, stdout: "bad\n" } : { status: 0, stdout: "{" };

/** Runs the script's command line in the repository. */
const runScript = (args: readonly string[]) =>
  spawnSync(process.execPath, ["scripts/release-packages.ts", ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });

describe("releasePackagesFrom", () => {
  it("leaves out private packages and orders the core first, then by directory", () => {
    assert.deepEqual(
      releasePackagesFrom([
        { directory: "hardhat-kms-zeta", manifest: manifest("@hardhat-kms/zeta") },
        { directory: "tool", manifest: manifest("tool", { private: true }) },
        { directory: "hardhat-kms-alpha", manifest: manifest("@hardhat-kms/alpha") },
        { directory: "hardhat-kms", manifest: manifest("hardhat-kms") },
      ]),
      [
        { name: "hardhat-kms", directory: "hardhat-kms" },
        { name: "@hardhat-kms/alpha", directory: "hardhat-kms-alpha" },
        { name: "@hardhat-kms/zeta", directory: "hardhat-kms-zeta" },
      ],
    );
  });

  it("refuses a published manifest without a name, a duplicate name and a missing core", () => {
    const core = { directory: "hardhat-kms", manifest: manifest("hardhat-kms") };
    assert.throws(() => releasePackagesFrom([core, { directory: "x", manifest: {} }]), {
      message: "packages/x/package.json has no name and is not private",
    });
    assert.throws(
      () => releasePackagesFrom([core, { directory: "copy", manifest: manifest("hardhat-kms") }]),
      { message: "packages/hardhat-kms and packages/copy are both named hardhat-kms" },
    );
    assert.throws(
      () => releasePackagesFrom([{ directory: "a", manifest: manifest("@hardhat-kms/a") }]),
      { message: "no published package under packages/ is named hardhat-kms" },
    );
  });
});

describe("releasePackagesAt", () => {
  const tree: Record<string, string> = {
    "packages/hardhat-kms/package.json": JSON.stringify({ name: "hardhat-kms" }),
    "packages/hardhat-kms-aws/package.json": JSON.stringify({ name: "@hardhat-kms/aws" }),
    "packages/tool/package.json": JSON.stringify({ name: "tool", private: true }),
  };
  const git = (args: readonly string[]) => {
    if (args[0] === "ls-tree") {
      return { status: 0, stdout: "hardhat-kms\nhardhat-kms-aws\ntool\n" };
    }
    const file = String(args[1]).replace(/^[^:]+:/, "");
    const text = tree[file];
    return text === undefined ? { status: 128, stdout: "" } : { status: 0, stdout: text };
  };

  it("reads the manifests of the commit through git", () => {
    assert.deepEqual(releasePackagesAt("v1.0.0", git), [
      { name: "hardhat-kms", directory: "hardhat-kms" },
      { name: "@hardhat-kms/aws", directory: "hardhat-kms-aws" },
    ]);
  });

  it("fails on an unknown commit, a missing manifest and a manifest that is not JSON", () => {
    assert.throws(() => releasePackagesAt("nope", () => ({ status: 128, stdout: "" })), {
      message: "git cannot list packages/ at nope",
    });
    assert.throws(() => releasePackagesAt("v1.0.0", gap), {
      message: "packages/empty/package.json is missing at v1.0.0",
    });
    assert.throws(() => releasePackagesAt("v1.0.0", broken), {
      message: "packages/bad/package.json at v1.0.0 is not JSON",
    });
  });

  it("gives the same list for HEAD as the checkout when the checkout is clean", () => {
    const status = spawnSync("git", ["status", "--porcelain", "--", "packages"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (status.status !== 0 || status.stdout !== "") {
      return;
    }
    const atHead = releasePackagesAt("HEAD", (args) => {
      const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
      return { status: result.status, stdout: result.stdout };
    });
    assert.deepEqual(atHead, RELEASE_PACKAGES);
  });
});

describe("node scripts/release-packages.ts", () => {
  it("prints the names, or the directories, one per line", () => {
    const names = runScript([]);
    assert.equal(names.status, 0, names.stderr);
    assert.deepEqual(names.stdout.trim().split("\n"), PACKAGES);
    const directories = runScript(["--directories"]);
    assert.equal(directories.status, 0, directories.stderr);
    assert.deepEqual(
      directories.stdout.trim().split("\n"),
      RELEASE_PACKAGES.map((entry) => entry.directory),
    );
  });

  it("fails with one line on an unknown commit", () => {
    const result = runScript(["--commit", "refs/tags/v0.0.0-no-such-tag"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /git cannot list packages\/ at refs\/tags\/v0\.0\.0-no-such-tag/);
  });
});

describe("parseNameView", () => {
  const e404 = JSON.stringify({ error: { code: "E404", summary: "Not Found" } }, null, 2);

  it("reads npm 11's string and npm 12's one-element array as published", () => {
    for (const stdout of ['"@hardhat-kms/aws"', '[\n  "@hardhat-kms/aws"\n]']) {
      assert.equal(parseNameView("@hardhat-kms/aws", { status: 0, stdout }), "published");
    }
  });

  it("reads npm's E404 error as missing, also inside a one-element array", () => {
    assert.equal(parseNameView("@hardhat-kms/turnkey", { status: 1, stdout: e404 }), "missing");
    assert.equal(
      parseNameView("@hardhat-kms/turnkey", { status: 1, stdout: `[${e404}]` }),
      "missing",
    );
  });

  it("refuses any other answer instead of guessing", () => {
    assert.throws(
      () => parseNameView("x", { status: 1, stdout: '{"error":{"code":"ETIMEDOUT"}}' }),
      { message: 'npm view x name exited 1 and printed {"error":{"code":"ETIMEDOUT"}}' },
    );
    assert.throws(() => parseNameView("x", { status: 0, stdout: '"y"' }), {
      message: 'npm view x name exited 0 and printed "y"',
    });
    assert.throws(() => parseNameView("x", { status: 0, stdout: e404 }), {
      message: /^npm view x name exited 0 and printed/,
    });
    assert.throws(() => parseNameView("x", { status: 1, stdout: "" }), {
      message: "npm view x name exited 1 and printed no JSON",
    });
    assert.throws(() => parseNameView("x", { status: 0, stdout: '["x","x"]' }), {
      message: /printed an array of 2 entries/,
    });
  });

  it("names the package and the owner's steps when one is missing", () => {
    assert.equal(
      missingMessage(["@hardhat-kms/turnkey"]),
      "@hardhat-kms/turnkey does not exist on npm yet, so it has no trusted publisher and cannot be staged over OIDC. The owner publishes the name once and sets up its trusted publishers first: docs/contributor/releasing.md, First publish of a new package.",
    );
    assert.match(missingMessage(["a", "b"]), /^a, b do not exist on npm yet, so they have no/);
  });
});
