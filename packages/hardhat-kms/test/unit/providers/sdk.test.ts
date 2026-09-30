import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { HardhatPluginError } from "hardhat/plugins";
import { z } from "zod";

import { createProviderDeps } from "../../../src/internal/providers/deps.ts";
import { loadSdk } from "../../../src/internal/providers/sdk.ts";
import type { KmsProviderDescriptor } from "../../../src/internal/providers/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/** A throwaway monorepo: `root/node_modules` holds hoisted packages, `root/app` is the project. */
let root: string;
let project: string;
let elsewhere: string;

interface FakePackage {
  name: string;
  manifest?: Record<string, unknown>;
  /** Extra files, by path relative to the package. */
  files?: Record<string, string>;
  /** The node_modules folder to install into. Defaults to the project's. */
  into?: string;
}

function install({
  name,
  manifest = {},
  files = {},
  into = path.join(project, "node_modules"),
}: FakePackage): void {
  const directory = path.join(into, ...name.split("/"));
  const all: Record<string, string> = {
    "package.json": JSON.stringify({ name, main: "lib/index.js", ...manifest }),
    "lib/index.js": `exports.marker = ${JSON.stringify(name)};`,
    ...files,
  };
  for (const [file, content] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), content);
  }
}

async function assertPluginError(promise: Promise<unknown>, includes: string[]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HardhatPluginError);
    for (const part of includes) {
      assert.ok(error.message.includes(part), `"${error.message}" should include "${part}"`);
    }
    return true;
  });
}

const sdk = (packageName: string, range = "^3.0.0") => ({ packageName, range });

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "hardhat-kms-sdk-"));
  project = path.join(root, "app");
  elsewhere = path.join(root, "elsewhere", "node_modules");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "monorepo", private: true }),
  );
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "app", private: true }));
  install({ name: "@fake/kms", manifest: { version: "3.4.5" } });
  install({ name: "@fake/old", manifest: { version: "2.9.9" } });
  install({ name: "@fake/unversioned" });
  install({ name: "@fake/empty-version", manifest: { version: "" } });
  install({ name: "@fake/beta", manifest: { version: "3.5.0-beta.1" } });
  install({
    name: "@fake/hoisted",
    manifest: { version: "3.0.0" },
    into: path.join(root, "node_modules"),
  });
  install({ name: "@fake/global", manifest: { version: "3.0.0" }, into: elsewhere });
  // Entry points in folders with their own package.json, as tshy and similar tools emit.
  install({
    name: "@fake/typed-dist",
    manifest: { version: "3.1.0", main: "dist/commonjs/index.js" },
    files: {
      "dist/commonjs/package.json": JSON.stringify({ type: "commonjs" }),
      "dist/commonjs/index.js": "exports.marker = 'typed-dist';",
    },
  });
  install({
    name: "@fake/inner-named",
    manifest: { version: "3.2.0", main: "inner/index.js" },
    files: {
      "inner/package.json": JSON.stringify({ name: "inner", version: "9.9.9" }),
      "inner/index.js": "exports.marker = 'inner-named';",
    },
  });
  install({
    name: "@fake/esm-only",
    manifest: {
      version: "3.0.0",
      type: "module",
      exports: { ".": { import: "./lib/index.js" } },
    },
    files: { "lib/index.js": "export const marker = 'esm';" },
  });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadSdk", () => {
  it("loads a package from the project, not from the plugin's own dependencies", async () => {
    const module = await loadSdk(sdk("@fake/kms"), project, "fake");

    assert.ok(typeof module === "object" && module !== null && "marker" in module);
    assert.equal(module.marker, "@fake/kms");
  });

  it("finds packages hoisted to a monorepo root", async () => {
    await loadSdk(sdk("@fake/hoisted"), project, "fake");
  });

  it("reads the version from the package's own package.json, past nested ones", async () => {
    await loadSdk(sdk("@fake/typed-dist"), project, "fake");
    await loadSdk(sdk("@fake/inner-named", "^3.2.0"), project, "fake");
    await assertPluginError(loadSdk(sdk("@fake/inner-named", "^9.0.0"), project, "fake"), [
      "found @fake/inner-named 3.2.0",
    ]);
  });

  it("names the provider, the package and the install command when the package is missing", async () => {
    await assertPluginError(loadSdk(sdk("@fake/missing", "^1.0.0"), project, "fake"), [
      "fake, load SDK: @fake/missing is not installed",
      'npm install @fake/missing@"^1.0.0"',
    ]);
  });

  it("says a package that cannot be required is installed, with the reason", async () => {
    await assertPluginError(loadSdk(sdk("@fake/esm-only"), project, "fake"), [
      "@fake/esm-only is installed but cannot be loaded (ERR_PACKAGE_PATH_NOT_EXPORTED)",
    ]);
  });

  it("rejects versions outside the range, unknown versions and prereleases", async () => {
    await assertPluginError(loadSdk(sdk("@fake/old"), project, "fake"), [
      "fake, load SDK: found @fake/old 2.9.9, but this plugin supports ^3.0.0.",
      'npm install @fake/old@"^3.0.0"',
    ]);
    for (const name of ["@fake/unversioned", "@fake/empty-version"]) {
      await assertPluginError(loadSdk(sdk(name), project, "fake"), [
        `found ${name} with an unknown version`,
      ]);
    }
    await assertPluginError(loadSdk(sdk("@fake/beta"), project, "fake"), [
      "found @fake/beta 3.5.0-beta.1",
      "Prerelease versions are not supported.",
    ]);
  });

  it("does not find packages that only this plugin depends on", async () => {
    // zod is a dependency of the plugin, but not of the throwaway project. Node may still find the
    // plugin's copy through NODE_PATH (pnpm sets it for scripts); then it must be refused as
    // outside the project. Either way it is not loaded.
    await assert.rejects(loadSdk(sdk("zod"), project, "fake"), (error: unknown) => {
      assert.ok(error instanceof HardhatPluginError);
      assert.match(error.message, /zod is not installed|zod was found outside this project/);
      return true;
    });
  });

  it("refuses a package that Node finds outside the project, through NODE_PATH", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { loadSdk } = await import(${JSON.stringify(new URL("../../../src/internal/providers/sdk.ts", import.meta.url).href)});
         await loadSdk({ packageName: "@fake/global", range: "^3.0.0" }, ${JSON.stringify(project)}, "fake");`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, NODE_PATH: elsewhere },
        cwd: here,
        timeout: 30_000,
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /@fake\/global was found outside this project/);
  });
});

describe("createProviderDeps", () => {
  const descriptor: KmsProviderDescriptor = {
    id: "fake",
    schema: z.never(),
    resolve: () => {
      throw new Error("unused");
    },
    sdks: [sdk("@fake/kms")],
    load: async () => await Promise.reject(new Error("unused")),
  };

  it("loads the SDKs the provider declares", async () => {
    const module = await createProviderDeps(descriptor, project).loadSdk("@fake/kms");

    assert.ok(typeof module === "object" && module !== null && "marker" in module);
  });

  it("refuses packages the provider does not declare, even if installed", async () => {
    await assertPluginError(createProviderDeps(descriptor, project).loadSdk("@fake/old"), [
      "fake, load SDK: the provider does not declare @fake/old",
    ]);
  });
});
