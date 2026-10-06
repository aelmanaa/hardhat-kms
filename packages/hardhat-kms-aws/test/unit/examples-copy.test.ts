// The examples copy of registry mode (`test/helpers/examples-copy.ts`): the rewritten manifests
// and what the copy leaves behind. Runs on a small examples directory made here, never on examples/.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { copyExamples, withPluginVersion } from "../helpers/examples-copy.ts";

const manifest = {
  name: "hardhat-kms-example-viem",
  private: true,
  type: "module",
  scripts: { deploy: "hardhat run scripts/deploy.ts" },
  devDependencies: {
    "@nomicfoundation/hardhat-viem": "^3.0.9",
    hardhat: "^3.18.0",
    "hardhat-kms": "^0.0.0",
    "@hardhat-kms/aws": "^0.0.0",
    viem: "^2.57.1",
  },
};

describe("withPluginVersion", () => {
  it("pins hardhat-kms and @hardhat-kms/aws and leaves the other ranges and the field order", () => {
    const rewritten = withPluginVersion(manifest, "1.2.3");
    assert.deepEqual(rewritten, {
      ...manifest,
      devDependencies: {
        "@nomicfoundation/hardhat-viem": "^3.0.9",
        hardhat: "^3.18.0",
        "hardhat-kms": "1.2.3",
        "@hardhat-kms/aws": "1.2.3",
        viem: "^2.57.1",
      },
    });
    assert.deepEqual(Object.keys(rewritten), Object.keys(manifest));
    const devDependencies: unknown = rewritten.devDependencies;
    assert.ok(typeof devDependencies === "object" && devDependencies !== null);
    assert.deepEqual(Object.keys(devDependencies), Object.keys(manifest.devDependencies));
    assert.equal(manifest.devDependencies["hardhat-kms"], "^0.0.0", "the input is not changed");
  });

  it("refuses a manifest without one of the two packages, naming it", () => {
    const { "@hardhat-kms/aws": _aws, ...without } = manifest.devDependencies;
    assert.throws(() => withPluginVersion({ ...manifest, devDependencies: without }, "1.2.3"), {
      message: "hardhat-kms-example-viem does not list @hardhat-kms/aws under devDependencies",
    });
    assert.throws(() => withPluginVersion({ name: "bare" }, "1.2.3"), {
      message: "bare has no devDependencies",
    });
  });
});

describe("copyExamples", () => {
  // The helper copies into a directory the test removes afterwards, so the test runs under a temp
  // directory of its own (the sandbox rule of docs/contributor/testing.md).
  const variables = ["TMPDIR", "TEMP", "TMP"];
  const saved = new Map(variables.map((name) => [name, process.env[name]]));
  let sandbox = "";
  let source = "";
  before(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), "hardhat-kms-test-"));
    for (const name of variables) {
      process.env[name] = sandbox;
    }
    assert.equal(path.resolve(tmpdir()), path.resolve(sandbox));
    source = path.join(sandbox, "examples");
    for (const example of ["viem", "ignition"]) {
      const directory = path.join(source, example);
      mkdirSync(path.join(directory, "contracts"), { recursive: true });
      mkdirSync(path.join(directory, "node_modules", "hardhat"), { recursive: true });
      mkdirSync(path.join(directory, "artifacts"), { recursive: true });
      mkdirSync(path.join(directory, "cache"), { recursive: true });
      writeFileSync(path.join(directory, "contracts", "Counter.sol"), "contract Counter {}\n");
      writeFileSync(path.join(directory, "node_modules", "hardhat", "package.json"), "{}\n");
      writeFileSync(path.join(directory, "artifacts", "build-info.json"), "{}\n");
      writeFileSync(
        path.join(directory, "package.json"),
        `${JSON.stringify({ ...manifest, name: `hardhat-kms-example-${example}` }, null, 2)}\n`,
      );
    }
    mkdirSync(path.join(source, "ignition", "ignition", "modules"), { recursive: true });
    mkdirSync(path.join(source, "ignition", "ignition", "deployments", "chain-31337"), {
      recursive: true,
    });
    writeFileSync(
      path.join(source, "ignition", "ignition", "modules", "Counter.ts"),
      "export {};\n",
    );
    writeFileSync(path.join(source, "README.md"), "# Examples\n");
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

  it("copies each example without installs and build output, with the version written", () => {
    const destination = mkdtempSync(path.join(tmpdir(), "hhkms-examples-"));
    assert.deepEqual(copyExamples(source, destination, "1.2.3"), ["ignition", "viem"]);
    for (const example of ["viem", "ignition"]) {
      const directory = path.join(destination, example);
      assert.equal(existsSync(path.join(directory, "contracts", "Counter.sol")), true);
      assert.equal(existsSync(path.join(directory, "node_modules")), false);
      assert.equal(existsSync(path.join(directory, "artifacts")), false);
      assert.equal(existsSync(path.join(directory, "cache")), false);
      const copied: unknown = JSON.parse(
        readFileSync(path.join(directory, "package.json"), "utf8"),
      );
      assert.deepEqual(Reflect.get(Object(copied), "devDependencies"), {
        "@nomicfoundation/hardhat-viem": "^3.0.9",
        hardhat: "^3.18.0",
        "hardhat-kms": "1.2.3",
        "@hardhat-kms/aws": "1.2.3",
        viem: "^2.57.1",
      });
    }
    assert.equal(
      existsSync(path.join(destination, "ignition", "ignition", "modules", "Counter.ts")),
      true,
    );
    assert.equal(existsSync(path.join(destination, "ignition", "ignition", "deployments")), false);
    assert.equal(existsSync(path.join(destination, "README.md")), false, "files are not examples");
    // The source keeps its ranges.
    const original: unknown = JSON.parse(
      readFileSync(path.join(source, "viem", "package.json"), "utf8"),
    );
    assert.equal(
      Reflect.get(Object(Reflect.get(Object(original), "devDependencies")), "hardhat-kms"),
      "^0.0.0",
    );
  });
});
