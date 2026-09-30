import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { configVariable } from "hardhat/config";

import { assertError, validate } from "../../helpers/config-validation.ts";

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const GCP_NAME = "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1";

describe("validateKmsUserConfig", () => {
  it("accepts a config without a kms section", () => {
    assert.deepEqual(validate({}), []);
    assert.deepEqual(validate({ networks: { sepolia: { type: "http", url: "http://x" } } }), []);
  });

  it("accepts every key form of every provider, literal or from configuration variables", () => {
    const config = {
      kms: {
        defaults: { aws: { region: "eu-west-1" }, timeoutMs: 10_000, approvalTimeoutMs: 600_000 },
        allowCrossChainTypedData: true,
        simulatedBalance: 10n ** 18n,
        keys: {
          awsAlias: { provider: "aws", keyId: "alias/deployer", address: ADDRESS, profile: "ci" },
          awsVariable: {
            provider: "aws",
            keyId: configVariable("AWS_KMS_KEY_ID"),
            endpoint: "http://localhost:4566",
          },
          gcpName: { provider: "gcp", keyVersionName: GCP_NAME, timeoutMs: 5000 },
          gcpParts: {
            provider: "gcp",
            projectId: configVariable("GCP_PROJECT_ID"),
            location: "europe-west1",
            keyRing: "ring",
            keyName: "deployer",
            keyVersion: 3,
          },
          azureId: {
            provider: "azure",
            keyId: "https://ops.vault.azure.net/keys/deployer/0123abcd",
          },
          azureParts: {
            provider: "azure",
            vaultUrl: configVariable("AZURE_VAULT_URL"),
            keyName: "deployer",
          },
          external: { provider: "myvault", keyPath: "a/b", address: ADDRESS.toLowerCase() },
        },
      },
      networks: {
        sepolia: {
          type: "http",
          url: "http://x",
          kmsAccounts: ["awsAlias", { provider: "aws", keyId: "alias/ops" }],
        },
      },
    };

    assert.deepEqual(validate(config), []);
  });

  it("reports an unknown key name at the exact kmsAccounts index, listing the known keys", () => {
    const config = {
      kms: { keys: { deployer: { provider: "aws", keyId: "alias/deployer" } } },
      networks: { sepolia: { kmsAccounts: ["deployer", "deployr"] } },
    };

    assertError(
      config,
      "networks.sepolia.kmsAccounts.1",
      'Unknown key "deployr". Known keys: deployer.',
    );
    assertError(
      { networks: { sepolia: { kmsAccounts: ["x"] } } },
      "networks.sepolia.kmsAccounts.0",
      "`kms.keys` is empty",
    );
  });

  it("reports a key listed twice on one network", () => {
    const config = {
      kms: { keys: { deployer: { provider: "aws", keyId: "alias/deployer" } } },
      networks: { sepolia: { kmsAccounts: ["deployer", "deployer"] } },
    };

    assertError(config, "networks.sepolia.kmsAccounts.1", "listed twice");
  });

  it("reports errors inside inline keys at their exact path", () => {
    assertError(
      { networks: { sepolia: { kmsAccounts: [{ provider: "aws", keyId: "deployer" }] } } },
      "networks.sepolia.kmsAccounts.0.keyId",
      "alias name",
    );
    assertError(
      { networks: { sepolia: { kmsAccounts: [42] } } },
      "networks.sepolia.kmsAccounts.0",
      "Expected the name",
    );
  });

  it("rejects a misspelled built-in provider instead of treating it as a third-party one", () => {
    assertError(
      { kms: { keys: { a: { provider: "AWS", keyId: "alias/a" } } } },
      "kms.keys.a.provider",
      'Did you mean "aws"?',
    );
    assertError(
      { kms: { keys: { a: { provider: "azrue", keyId: "https://attacker.example/keys/k" } } } },
      "kms.keys.a.provider",
      'Did you mean "azure"?',
    );
    assert.deepEqual(validate({ kms: { keys: { a: { provider: "myvault" } } } }), []);
  });

  it("rejects __proto__ as a key name", () => {
    const keys: Record<string, unknown> = {};
    Object.defineProperty(keys, "__proto__", {
      value: { provider: "aws", keyId: "alias/a" },
      enumerable: true,
    });

    assertError({ kms: { keys } }, "kms.keys.__proto__", "Key names");
  });

  it("rejects GCP versions beyond the safe integer range and `.` or `..` components", () => {
    assertError(
      {
        kms: {
          keys: {
            a: {
              provider: "gcp",
              projectId: "p",
              location: "l",
              keyRing: "r",
              keyName: "k",
              keyVersion: 1e21,
            },
          },
        },
      },
      "kms.keys.a.keyVersion",
      "Expected a positive integer",
    );
    assertError(
      {
        kms: {
          keys: {
            a: {
              provider: "gcp",
              projectId: "..",
              location: "l",
              keyRing: "r",
              keyName: "k",
              keyVersion: 1,
            },
          },
        },
      },
      "kms.keys.a.projectId",
      "not `.` or `..`",
    );
  });

  it("rejects invalid key names", () => {
    assertError(
      { kms: { keys: { "my key": { provider: "aws", keyId: "alias/a" } } } },
      "kms.keys.my key",
      "Key names",
    );
  });

  it("rejects a key without a provider, or with a typo in a field", () => {
    assertError({ kms: { keys: { a: { keyId: "alias/a" } } } }, "kms.keys.a", "`provider` field");
    assertError(
      { kms: { keys: { a: { provider: "aws", keyID: "alias/a" } } } },
      "kms.keys.a.keyId",
      "Expected a string",
    );
    assertError(
      { kms: { keys: { a: { provider: "aws", keyId: "alias/a", regoin: "x" } } } },
      "kms.keys.a",
      "regoin",
    );
  });

  it("rejects a region that conflicts with the key ARN", () => {
    const keyId = "arn:aws:kms:eu-west-1:111122223333:alias/deployer";

    assertError(
      { kms: { keys: { a: { provider: "aws", keyId, region: "us-east-1" } } } },
      "kms.keys.a.region",
      "eu-west-1",
    );
    assert.deepEqual(
      validate({ kms: { keys: { a: { provider: "aws", keyId, region: "eu-west-1" } } } }),
      [],
    );
  });

  it("rejects malformed GCP names and mixed GCP forms", () => {
    assertError(
      { kms: { keys: { a: { provider: "gcp", keyVersionName: "projects/p" } } } },
      "kms.keys.a.keyVersionName",
      "cryptoKeyVersions",
    );
    assertError(
      { kms: { keys: { a: { provider: "gcp", keyVersionName: GCP_NAME, keyVersion: 2 } } } },
      "kms.keys.a.keyVersion",
      "not both",
    );
    assertError(
      {
        kms: {
          keys: {
            a: { provider: "gcp", projectId: "p", location: "l", keyRing: "r", keyName: "k" },
          },
        },
      },
      "kms.keys.a.keyVersion",
      "positive integer",
    );
    assertError(
      {
        kms: {
          keys: {
            a: {
              provider: "gcp",
              projectId: "p/x",
              location: "l",
              keyRing: "r",
              keyName: "k",
              keyVersion: "1",
            },
          },
        },
      },
      "kms.keys.a.projectId",
      "not `.` or `..`",
    );
    assertError(
      {
        kms: {
          keys: {
            a: {
              provider: "gcp",
              projectId: "p",
              location: "l",
              keyRing: "r",
              keyName: "k",
              keyVersion: "latest",
            },
          },
        },
      },
      "kms.keys.a.keyVersion",
      "positive integer version",
    );
  });

  it("rejects Azure keys on hosts that are not Azure vaults", () => {
    assertError(
      { kms: { keys: { a: { provider: "azure", keyId: "https://evil.example/keys/k" } } } },
      "kms.keys.a.keyId",
      "Azure Key Vault",
    );
    assertError(
      {
        kms: { keys: { a: { provider: "azure", vaultUrl: "https://evil.example", keyName: "k" } } },
      },
      "kms.keys.a.vaultUrl",
      "Azure Key Vault",
    );
    assertError(
      {
        kms: {
          keys: {
            a: { provider: "azure", keyId: "https://ops.vault.azure.net/keys/k", keyName: "k" },
          },
        },
      },
      "kms.keys.a.keyName",
      "not both",
    );
  });

  it("rejects invalid Azure key names and versions", () => {
    const vaultUrl = "https://ops.vault.azure.net";

    assertError(
      { kms: { keys: { a: { provider: "azure", vaultUrl, keyName: "bad_name" } } } },
      "kms.keys.a.keyName",
      "letters, digits or dashes",
    );
    assertError(
      { kms: { keys: { a: { provider: "azure", vaultUrl, keyName: "k", keyVersion: "v-1" } } } },
      "kms.keys.a.keyVersion",
      "letters and digits",
    );
    assert.deepEqual(
      validate({
        kms: { keys: { a: { provider: "azure", vaultUrl, keyName: "k", keyVersion: "abc123" } } },
      }),
      [],
    );
  });

  it("rejects bad address pins and timeouts", () => {
    const wrongChecksum = "0xF39fd6e51aad88F6F4ce6aB8827279cffFb92266";

    assertError(
      { kms: { keys: { a: { provider: "aws", keyId: "alias/a", address: wrongChecksum } } } },
      "kms.keys.a.address",
      "EIP-55",
    );
    assertError(
      { kms: { keys: { a: { provider: "myvault", address: "0x12" } } } },
      "kms.keys.a.address",
      "20-byte",
    );
    for (const [timeoutMs, message] of [
      [0, "at least 1 ms"],
      [-1, "at least 1 ms"],
      [1.5, "integer number of milliseconds"],
      [2 ** 31, "at most 2147483647 ms"],
    ] as const) {
      assertError(
        { kms: { keys: { a: { provider: "aws", keyId: "alias/a", timeoutMs } } } },
        "kms.keys.a.timeoutMs",
        message,
        1,
      );
    }
    assertError(
      { kms: { defaults: { timeoutMs: "30s" } } },
      "kms.defaults.timeoutMs",
      "milliseconds",
    );
  });

  it("rejects unknown fields in the kms section and a negative simulated balance", () => {
    assertError({ kms: { key: {} } }, "kms", "Unrecognized key(s) in object: 'key'", 1);
    assertError(
      { kms: { simulatedBalance: -1n } },
      "kms.simulatedBalance",
      "non-negative amount of wei",
      1,
    );
    assertError(
      { kms: { simulatedBalance: 1 } },
      "kms.simulatedBalance",
      "bigint amount of wei",
      1,
    );
  });
});
