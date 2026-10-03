import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsPlugin from "../../src/index.ts";
import type { AwsKmsKeyConfig, AwsKmsKeyUserConfig } from "../../src/types.ts";

describe("config in a Hardhat runtime environment", () => {
  it("resolves the kms section and each network's kmsAccounts", async () => {
    const hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKmsPlugin],
      kms: {
        keys: {
          deployer: {
            provider: "aws",
            keyId: configVariable("HHKMS_TEST_KEY_ID"),
            region: "eu-west-1",
          },
        },
      },
      networks: {
        sepolia: {
          type: "http",
          url: "http://127.0.0.1:1",
          chainId: 11155111,
          kmsAccounts: ["deployer"],
        },
        fork: {
          type: "edr-simulated",
          kmsAccounts: [
            {
              provider: "gcp",
              keyVersionName: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
            },
          ],
        },
      },
    });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- configured as an AWS key above
    const deployer = hre.config.kms.keys.deployer as AwsKmsKeyConfig;

    assert.equal(deployer.displayId, "aws:<HHKMS_TEST_KEY_ID>");
    assert.equal(deployer.region?.display, "eu-west-1");
    assert.equal(await deployer.region.get(), "eu-west-1");
    assert.equal(hre.config.networks.sepolia?.kmsAccounts[0], deployer);
    assert.equal(
      hre.config.networks.fork?.kmsAccounts[0]?.displayId,
      "gcp:projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
    );
    assert.deepEqual(hre.config.networks.default?.kmsAccounts, []);
  });

  it("fails with the exact path of an invalid value", async () => {
    await assert.rejects(
      createHardhatRuntimeEnvironment({
        plugins: [hardhatKmsPlugin],
        kms: { keys: { deployer: { provider: "aws", keyId: "alias/deployer" } } },
        networks: {
          sepolia: {
            type: "http",
            url: "http://127.0.0.1:1",
            kmsAccounts: ["deployer", "deployr"],
          },
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /networks\.sepolia\.kmsAccounts\.1/);
        assert.match(error.message, /Unknown key "deployr"/);
        return true;
      },
    );
  });

  it("fails at load on an approvalTimeoutMs, naming it and the key's path", async () => {
    const base: AwsKmsKeyUserConfig = { provider: "aws", keyId: "alias/deployer" };
    // A spread, not a typed object literal: a JavaScript config has no excess-property check.
    const deployer = { ...base, approvalTimeoutMs: 600_000 };
    await assert.rejects(
      createHardhatRuntimeEnvironment({
        plugins: [hardhatKmsPlugin],
        kms: { keys: { deployer } },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /HHE15/);
        assert.match(
          error.message,
          /config\.kms\.keys\.deployer: Unrecognized key\(s\) in object: 'approvalTimeoutMs'/,
        );
        return true;
      },
    );
  });
});
