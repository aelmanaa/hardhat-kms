// The shared registry-mode helper of the package checks (`scripts/registry.ts`): the option
// parsing, the four specs and the check of the installed version. Runs in `pnpm test`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  assertInstalledVersion,
  exactVersion,
  PACKAGES,
  parseRegistryOptions,
  registryArguments,
  registrySpecs,
} from "../../scripts/registry.ts";

describe("parseRegistryOptions", () => {
  it("leaves the other arguments in their order, in tarball mode", () => {
    assert.deepEqual(parseRegistryOptions([]), { rest: [] });
    assert.deepEqual(parseRegistryOptions(["7.0.2"]), { rest: ["7.0.2"] });
    assert.deepEqual(parseRegistryOptions(["--summary", "out.md", "npm", "pnpm"]), {
      rest: ["--summary", "out.md", "npm", "pnpm"],
    });
  });

  it("reads --from-registry and --registry wherever they are", () => {
    assert.deepEqual(parseRegistryOptions(["--from-registry", "1.0.0", "7.0.2"]), {
      version: "1.0.0",
      rest: ["7.0.2"],
    });
    assert.deepEqual(
      parseRegistryOptions([
        "npm",
        "--registry",
        "http://127.0.0.1:4873",
        "--from-registry",
        "1.0.0-beta.1",
      ]),
      { version: "1.0.0-beta.1", registry: "http://127.0.0.1:4873", rest: ["npm"] },
    );
  });

  it("refuses a missing value, a range and --registry on its own", () => {
    assert.throws(() => parseRegistryOptions(["--from-registry"]), {
      message: "--from-registry needs a value",
    });
    assert.throws(() => parseRegistryOptions(["--from-registry", "--registry", "http://x"]), {
      message: "--from-registry needs a value",
    });
    for (const range of ["^1.0.0", "1.0", "latest", "1.0.0 "]) {
      assert.throws(() => parseRegistryOptions(["--from-registry", range]), {
        message: `${range} is not an exact version; --from-registry needs one, such as 1.0.0`,
      });
    }
    assert.throws(() => parseRegistryOptions(["--registry", "http://x", "7.0.2"]), {
      message: "--registry applies to registry mode only; add --from-registry <version>",
    });
  });
});

describe("registrySpecs and registryArguments", () => {
  it("name the four packages at the version, core first", () => {
    assert.deepEqual(PACKAGES, [
      "hardhat-kms",
      "@hardhat-kms/aws",
      "@hardhat-kms/gcp",
      "@hardhat-kms/azure",
    ]);
    assert.deepEqual(registrySpecs("1.2.3"), [
      "hardhat-kms@1.2.3",
      "@hardhat-kms/aws@1.2.3",
      "@hardhat-kms/gcp@1.2.3",
      "@hardhat-kms/azure@1.2.3",
    ]);
    assert.throws(() => registrySpecs("^1.2.3"), { message: /is not an exact version/ });
    assert.equal(exactVersion("0.0.0"), "0.0.0");
  });

  it("give npm the registry only when one is set", () => {
    assert.deepEqual(registryArguments(undefined), []);
    assert.deepEqual(registryArguments("http://127.0.0.1:4873"), [
      "--registry",
      "http://127.0.0.1:4873",
    ]);
  });
});

/** A project under the temp directory whose node_modules holds hardhat-kms at a version. */
function project(version: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "project-"));
  const installed = path.join(directory, "node_modules", "hardhat-kms");
  mkdirSync(installed, { recursive: true });
  writeFileSync(
    path.join(installed, "package.json"),
    JSON.stringify({ name: "hardhat-kms", version }),
  );
  return directory;
}

describe("assertInstalledVersion", () => {
  // The test removes the project it makes, so it runs under a temp directory of its own.
  const variables = ["TMPDIR", "TEMP", "TMP"];
  const saved = new Map(variables.map((name) => [name, process.env[name]]));
  let sandbox = "";
  before(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), "hardhat-kms-test-"));
    for (const name of variables) {
      process.env[name] = sandbox;
    }
    assert.equal(path.resolve(tmpdir()), path.resolve(sandbox));
  });
  after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("passes when the project resolves the requested version", () => {
    assertInstalledVersion(project("1.0.0"), "1.0.0");
  });

  it("fails with both versions when the project resolves another one", () => {
    const directory = project("1.0.1");
    assert.throws(() => assertInstalledVersion(directory, "1.0.0"), {
      message: `${directory} resolves hardhat-kms 1.0.1; --from-registry asked for 1.0.0`,
    });
  });

  it("fails when hardhat-kms is not installed at all", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "empty-"));
    assert.throws(() => assertInstalledVersion(directory, "1.0.0"), {
      message: `hardhat-kms is not installed for ${directory}`,
    });
  });
});
