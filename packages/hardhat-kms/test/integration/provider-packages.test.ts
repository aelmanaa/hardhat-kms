// A release guard: every built-in provider's adapter package is a workspace package, so a release
// cannot ship a descriptor that names a package nobody can install. It reads the other packages'
// manifests, outside this package, so it is an integration test: Stryker's sandbox holds only this
// package.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { BUILTIN_PROVIDERS } from "../../src/internal/providers/registry.ts";

const packages = new URL("../../../", import.meta.url);

/**
 * Built-in providers whose package is not written yet. Each entry blocks a release: remove it in
 * the pull request that adds the package.
 */
const PENDING_PACKAGES: ReadonlySet<string> = new Set<string>();

async function workspacePackageNames(): Promise<Set<string>> {
  const names = new Set<string>();
  for (const entry of await readdir(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifest: unknown = JSON.parse(
      await readFile(new URL(`${entry.name}/package.json`, packages), "utf8"),
    );
    const name: unknown =
      typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "name") : undefined;
    assert.equal(typeof name, "string", `${entry.name}/package.json has no name`);
    names.add(String(name));
  }
  return names;
}

describe("built-in provider packages", () => {
  it("name a workspace package for every provider but the pending ones", async () => {
    const names = await workspacePackageNames();
    assert.ok(names.has("hardhat-kms"), [...names].join(", "));
    for (const [id, provider] of Object.entries(BUILTIN_PROVIDERS)) {
      assert.ok("package" in provider.adapter, `${id} names no package`);
      const { package: name } = provider.adapter;
      if (PENDING_PACKAGES.has(id)) {
        assert.equal(
          names.has(name),
          false,
          `${name} exists now: remove "${id}" from PENDING_PACKAGES`,
        );
      } else {
        assert.ok(names.has(name), `${id}: ${name} is not a workspace package`);
      }
    }
  });

  it("lists only built-in providers as pending", () => {
    for (const id of PENDING_PACKAGES) {
      assert.ok(Object.hasOwn(BUILTIN_PROVIDERS, id), id);
    }
    assert.deepEqual([...PENDING_PACKAGES], []);
  });
});
