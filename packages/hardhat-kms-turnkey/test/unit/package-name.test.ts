import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import hardhatKms from "hardhat-kms";
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsTurnkey from "../../src/index.ts";
import { PACKAGE_NAME } from "../../src/internal/hook-handlers/kms.ts";

const manifest: unknown = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);
const name: unknown =
  typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "name") : undefined;

describe("the @hardhat-kms/turnkey package name", () => {
  it("is scoped under @hardhat-kms", () => {
    assert.equal(name, "@hardhat-kms/turnkey");
  });

  // Hardhat looks up npmPackage (or the id) to find the plugin's package.json, and prints the id
  // in its install errors, so both must be the name users install.
  it("is the plugin's id and npmPackage", () => {
    assert.equal(hardhatKmsTurnkey.id, name);
    assert.equal(hardhatKmsTurnkey.npmPackage, name);
  });

  it("is the name the kms handler reads its version under", () => {
    assert.equal(PACKAGE_NAME, name);
  });

  // The core's descriptor for turnkey keys names the package in the error for a key no plugin claims.
  it("is the package the core tells users to install", async () => {
    const hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKms],
      kms: {
        keys: {
          deployer: {
            provider: "turnkey",
            organizationId: "a3c1e9f2-5b7d-4e8a-9c0f-1d2e3f4a5b6c",
            address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
            apiPrivateKey: configVariable("HHKMS_TEST_TURNKEY_API_PRIVATE_KEY"),
          },
        },
      },
    });

    await assert.rejects(
      hre.tasks.getTask(["kms", "address"]).run({ key: "deployer" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(`need the ${String(name)} plugin`), error.message);
        assert.ok(
          error.message.includes(`\`npm install --save-dev ${String(name)}\``),
          error.message,
        );
        return true;
      },
    );
  });
});
