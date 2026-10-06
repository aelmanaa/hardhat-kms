// The manifest check of `pnpm run pkg:check` (`scripts/check-packages.ts`): a manifest that
// passes, then one missing or breaking each field it reads. Runs in `pnpm test` and never packs.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { manifestProblems } from "../../scripts/check-packages.ts";

const packed = ["package.json", "dist/src/index.js", "dist/src/index.d.ts", "README.md"];

const provider = {
  name: "@hardhat-kms/aws",
  description: "AWS KMS signer for Hardhat 3 (hardhat-kms provider).",
  keywords: ["hardhat-plugin", "hardhat", "hardhat-kms", "aws-kms"],
  author: { name: "Amine El Manaa", url: "https://github.com/aelmanaa" },
  types: "./dist/src/index.d.ts",
};

const core = {
  ...provider,
  name: "hardhat-kms",
  description: "Hardhat 3 plugin that signs with keys held in a cloud KMS.",
  keywords: ["hardhat-plugin", "hardhat", "kms"],
};

/** `manifest` without `key`. */
function without(manifest: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _removed, ...rest } = manifest;
  return rest;
}

describe("manifestProblems", () => {
  it("passes a provider manifest and the core manifest", () => {
    assert.deepEqual(manifestProblems(provider, packed), []);
    assert.deepEqual(manifestProblems(core, packed), []);
  });

  it("requires a top-level types that is in the tarball", () => {
    assert.deepEqual(manifestProblems(without(provider, "types"), packed), [
      '@hardhat-kms/aws: package.json has no top-level "types"',
    ]);
    assert.deepEqual(manifestProblems({ ...provider, types: "" }, packed), [
      '@hardhat-kms/aws: package.json has no top-level "types"',
    ]);
    assert.deepEqual(manifestProblems(provider, ["package.json", "dist/src/index.js"]), [
      '@hardhat-kms/aws: "types" is ./dist/src/index.d.ts, which is not in the tarball',
    ]);
  });

  it("requires an author object with name and url", () => {
    const expected = ['@hardhat-kms/aws: "author" must be an object with "name" and "url"'];
    assert.deepEqual(manifestProblems(without(provider, "author"), packed), expected);
    assert.deepEqual(manifestProblems({ ...provider, author: "Amine El Manaa" }, packed), expected);
    assert.deepEqual(
      manifestProblems({ ...provider, author: { name: "Amine El Manaa" } }, packed),
      expected,
    );
    assert.deepEqual(
      manifestProblems({ ...provider, author: { name: "", url: "https://example.com" } }, packed),
      expected,
    );
  });

  it("requires a description under 200 characters that says Hardhat 3", () => {
    assert.deepEqual(manifestProblems(without(provider, "description"), packed), [
      '@hardhat-kms/aws: package.json has no "description"',
    ]);
    assert.deepEqual(
      manifestProblems({ ...provider, description: "AWS KMS signer for Hardhat." }, packed),
      ['@hardhat-kms/aws: "description" does not say "Hardhat 3"'],
    );
    const long = `Hardhat 3 ${"x".repeat(190)}`;
    assert.deepEqual(manifestProblems({ ...provider, description: long }, packed), [
      `@hardhat-kms/aws: "description" is ${long.length} characters; keep it under 200`,
    ]);
  });

  it("requires keywords to start with hardhat-plugin", () => {
    const expected = ['@hardhat-kms/aws: "keywords" must start with "hardhat-plugin"'];
    assert.deepEqual(manifestProblems(without(provider, "keywords"), packed), expected);
    assert.deepEqual(manifestProblems({ ...provider, keywords: [] }, packed), expected);
    assert.deepEqual(
      manifestProblems({ ...provider, keywords: ["hardhat", "hardhat-plugin"] }, packed),
      expected,
    );
  });

  it("requires a provider, not the core, to list hardhat-kms in keywords", () => {
    assert.deepEqual(
      manifestProblems({ ...provider, keywords: ["hardhat-plugin", "aws-kms"] }, packed),
      ['@hardhat-kms/aws: "keywords" must include "hardhat-kms" so the family surfaces together'],
    );
    assert.deepEqual(manifestProblems({ ...core, keywords: ["hardhat-plugin"] }, packed), []);
  });

  it("reports every problem of a manifest at once, labelled by name when there is one", () => {
    const problems = manifestProblems({ keywords: ["hardhat"] }, packed);
    assert.equal(problems.length, 4);
    assert.ok(problems.every((problem) => problem.startsWith("package: ")));
  });
});
