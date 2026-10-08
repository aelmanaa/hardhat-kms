// The live suite's package loader (helpers/packages.ts): the resolve hook of registry mode, the
// guarded removal of scratch projects, and that no live file imports the checkout's packages other
// than through the loader's source mode. Runs offline, in `pnpm test`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { packageName, removeScratchProject } from "./helpers/packages.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, "../..");

/** The only imports of the checkout's packages in test/live: the loader's source mode. */
const SOURCE_IMPORTS = [
  "../../../packages/hardhat-kms-aws/src/index.ts",
  "../../../packages/hardhat-kms-gcp/src/index.ts",
  "../../../packages/hardhat-kms-azure/src/index.ts",
];

/** Every `.ts` file under test/live, except the fixture project's build output. */
function liveFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return ["artifacts", "cache", "node_modules"].includes(entry.name) ? [] : liveFiles(file);
    }
    return entry.name.endsWith(".ts") ? [file] : [];
  });
}

/** The specifiers of a file's static imports and exports and of its dynamic imports. */
function specifiers(text: string): string[] {
  return [
    ...text.matchAll(/\bfrom\s*"([^"]+)"/g),
    ...text.matchAll(/\bimport\s*\(\s*"([^"]+)"/g),
    ...text.matchAll(/^\s*import\s*"([^"]+)"/gm),
  ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

/** Writes a package with an ES module entry point. */
function writePackage(
  directory: string,
  name: string,
  code: string,
  peerDependencies: Record<string, string> = {},
): void {
  const folder = path.join(directory, "node_modules", ...name.split("/"));
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    path.join(folder, "package.json"),
    JSON.stringify({
      name,
      version: "9.9.9",
      type: "module",
      exports: "./index.js",
      peerDependencies,
    }),
  );
  writeFileSync(path.join(folder, "index.js"), code);
}

describe("live package loader", () => {
  it("reads the package name of a bare specifier only", () => {
    assert.equal(packageName("hardhat-kms"), "hardhat-kms");
    assert.equal(packageName("hardhat-kms/types"), "hardhat-kms");
    assert.equal(packageName("@hardhat-kms/aws"), "@hardhat-kms/aws");
    assert.equal(packageName("@hardhat-kms/aws/package.json"), "@hardhat-kms/aws");
    assert.equal(packageName("hardhat/hre"), "hardhat");
    for (const specifier of [
      "./x.js",
      "../x.js",
      "/x.js",
      "#internal",
      "node:fs",
      "file:///x.js",
      "",
    ]) {
      assert.equal(packageName(specifier), undefined, specifier);
    }
  });

  it("refuses to remove a directory it did not create", () => {
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "hardhat-kms-live-registry-")));
    try {
      assert.throws(() => removeScratchProject(directory), /this process did not create it/);
      assert.throws(() => removeScratchProject(tmpdir()), /this process did not create it/);
      assert.throws(() => removeScratchProject(repository), /this process did not create it/);
      assert.ok(readdirSync(directory).length === 0, "the directory is still there");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("imports the checkout's packages only in the loader's source mode", () => {
    for (const file of liveFiles(here)) {
      const relative = path.relative(here, file);
      const workspace = specifiers(readFileSync(file, "utf8")).filter(
        (specifier) => specifier.includes("packages/") || specifier.includes("/internal/"),
      );
      assert.deepEqual(
        workspace,
        relative === path.join("helpers", "packages.ts") ? SOURCE_IMPORTS : [],
        relative,
      );
    }
  });

  it("loads the four packages from the scratch project and their peers from the workspace", () => {
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "hardhat-kms-live-hook-")));
    try {
      // A stand-in for the installed packages: the core re-exports viem, its peer, and each
      // provider re-exports where the core came from.
      writePackage(
        directory,
        "hardhat-kms",
        'export * as viem from "viem";\nexport const url = import.meta.url;\n',
        { viem: "*" },
      );
      for (const name of ["@hardhat-kms/aws", "@hardhat-kms/gcp", "@hardhat-kms/azure"]) {
        writePackage(
          directory,
          name,
          'import { url } from "hardhat-kms";\nexport default { id: "fake", core: url };\n',
          { "hardhat-kms": "*", hardhat: "*" },
        );
      }
      const helper = path.join(here, "helpers", "packages.ts");
      const script = [
        `import { redirectPackages } from ${JSON.stringify(helper)};`,
        `const loaded = redirectPackages(${JSON.stringify(directory)});`,
        'const aws = await import("@hardhat-kms/aws");',
        'const core = await import("hardhat-kms");',
        'const viem = await import("viem");',
        'await import(new URL("../../packages/hardhat-kms/package.json", import.meta.url).href, { with: { type: "json" } }).catch(() => {});',
        "console.log(JSON.stringify({",
        "  aws: aws.default.core,",
        "  core: core.url,",
        "  sameViem: core.viem.keccak256 === viem.keccak256,",
        "  loaded,",
        "}));",
      ].join("\n");
      const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: here,
        encoding: "utf8",
      });
      const result: unknown = JSON.parse(output);
      const field = (name: string): unknown => Reflect.get(Object(result), name);
      const coreUrl = pathToFileURL(
        path.join(directory, "node_modules", "hardhat-kms", "index.js"),
      ).href;
      assert.equal(field("aws"), coreUrl);
      assert.equal(field("core"), coreUrl);
      assert.equal(field("sameViem"), true, "the scratch core did not load the workspace's viem");
      const loaded = field("loaded");
      assert.ok(Array.isArray(loaded));
      assert.equal(loaded.length, 1, "the hook did not record the module under packages/");
      assert.match(String(loaded[0]), /\/packages\/hardhat-kms\/package\.json$/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
