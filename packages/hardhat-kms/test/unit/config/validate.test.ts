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
        defaults: { aws: { region: "eu-west-1" }, timeoutMs: 10_000 },
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

  it("rejects the reserved fireblocks and pkcs11 ids and names their tracking issues", () => {
    for (const [provider, name, issue] of [
      ["fireblocks", "Fireblocks", 55],
      ["FIREBLOCKS", "Fireblocks", 55],
      ["pkcs11", "PKCS#11 HSM", 57],
      ["PKCS11", "PKCS#11 HSM", 57],
    ] as const) {
      const config = { kms: { keys: { a: { provider, vaultId: "v" } } } };
      assertError(
        config,
        "kms.keys.a.provider",
        `Provider "${provider}" is reserved for the planned ${name} provider, which is not released yet (https://github.com/aelmanaa/hardhat-kms/issues/${issue})`,
        1,
      );
      assertError(
        { networks: { sepolia: { kmsAccounts: [{ provider }] } } },
        "networks.sepolia.kmsAccounts.0.provider",
        `issues/${issue}`,
        1,
      );
    }
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
    for (const provider of ["myvault", "kms", "hsm", "gcpx-hsm"]) {
      assert.deepEqual(validate({ kms: { keys: { a: { provider } } } }), [], provider);
    }
    for (const [provider, meant] of [
      ["gpc", "gcp"],
      ["aw", "aws"],
      ["azurre", "azure"],
      ["Azure", "azure"],
      ["Turnkey", "turnkey"],
      ["TURNKEY", "turnkey"],
      ["turnky", "turnkey"],
      ["turnkye", "turnkey"],
    ] as const) {
      assertError(
        { kms: { keys: { a: { provider } } } },
        "kms.keys.a.provider",
        `Did you mean "${meant}"?`,
      );
    }
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

const inKeys = (key: unknown) => ({ kms: { keys: { a: key } } });
const inline = (key: unknown) => ({ networks: { sepolia: { kmsAccounts: [key] } } });

describe("validateKmsUserConfig: Turnkey keys", () => {
  const ORGANIZATION_ID = "f81d4fae-7dec-11d0-a765-00a0c91e6bf6";
  const turnkey = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
    provider: "turnkey",
    organizationId: ORGANIZATION_ID,
    address: ADDRESS,
    apiPrivateKey: configVariable("TURNKEY_API_PRIVATE_KEY"),
    ...fields,
  });

  it("accepts a key with an organization, an address and an API private key variable", () => {
    for (const key of [
      turnkey(),
      turnkey({ organizationId: ORGANIZATION_ID.toUpperCase() }),
      turnkey({
        organizationId: configVariable("TURNKEY_ORGANIZATION_ID"),
        apiPublicKey: configVariable("TURNKEY_API_PUBLIC_KEY"),
        timeoutMs: 10_000,
      }),
      turnkey({ apiPublicKey: "02abcdef", address: ADDRESS.toLowerCase() }),
      turnkey({ transactionSigning: "transaction" }),
      turnkey({ transactionSigning: "digest" }),
    ]) {
      assert.deepEqual(validate(inKeys(key)), []);
      assert.deepEqual(validate(inline(key)), []);
    }
  });

  it("fails each missing or invalid field at its path, in kms.keys and in kmsAccounts", () => {
    const { address: _address, ...withoutAddress } = turnkey();
    const { organizationId: _organization, ...withoutOrganization } = turnkey();
    const { apiPrivateKey: _private, ...withoutPrivateKey } = turnkey();
    for (const [key, field, message] of [
      [
        turnkey({ apiPrivateKey: "0x1234" }),
        "apiPrivateKey",
        "Expected `configVariable(NAME)` without a `default` or a `format`. A secret cannot be written in the config",
      ],
      [withoutPrivateKey, "apiPrivateKey", "Expected `configVariable(NAME)` without a `default`"],
      [
        withoutAddress,
        "address",
        "A Turnkey key needs `address`, the address of the wallet account that signs",
      ],
      [turnkey({ address: "0x1234" }), "address", "Expected a 0x-prefixed 20-byte address"],
      [withoutOrganization, "organizationId", "Expected a string or a Configuration Variable"],
      [
        turnkey({ organizationId: "test-organization" }),
        "organizationId",
        "Expected a Turnkey organization id, a UUID such as 00000000-0000-0000-0000-000000000000",
      ],
      [turnkey({ organizationId: ` ${ORGANIZATION_ID}` }), "organizationId", "a UUID"],
      [turnkey({ organizationId: `${ORGANIZATION_ID}0` }), "organizationId", "a UUID"],
      [turnkey({ apiPublicKey: 42 }), "apiPublicKey", "Expected a string or a Configuration"],
      [turnkey({ timeoutMs: 0 }), "timeoutMs", "at least 1"],
      [
        turnkey({ transactionSigning: "hash" }),
        "transactionSigning",
        "Invalid enum value. Expected 'transaction' | 'digest', received 'hash'",
      ],
      [turnkey({ transactionSigning: "Digest" }), "transactionSigning", "received 'Digest'"],
      [
        turnkey({ transactionSigning: true }),
        "transactionSigning",
        "Expected 'transaction' | 'digest'",
      ],
    ] as const) {
      assertError(inKeys(key), `kms.keys.a.${field}`, message, 1);
      assertError(inline(key), `networks.sepolia.kmsAccounts.0.${field}`, message, 1);
    }
  });

  it("rejects unknown fields, such as apiKey or baseUrl", () => {
    for (const field of ["apiKey", "baseUrl", "walletId"]) {
      assertError(
        inKeys(turnkey({ [field]: "x" })),
        "kms.keys.a",
        `Unrecognized key(s) in object: '${field}'`,
        1,
      );
    }
  });

  it("refuses an API private key in any form but a variable without a default or a format", () => {
    const secret = "hhkms-secret-api-private-key";
    const variable = { _type: "ConfigurationVariable", name: "TURNKEY_API_PRIVATE_KEY" } as const;
    for (const apiPrivateKey of [
      secret,
      configVariable("TURNKEY_API_PRIVATE_KEY", { default: secret }),
      // Text around `{variable}` is written in the config, and so is a format without it.
      configVariable("TURNKEY_API_PRIVATE_KEY", { format: `${secret}{variable}` }),
      configVariable("TURNKEY_API_PRIVATE_KEY", { format: `{variable}${secret}` }),
      { ...variable, format: secret },
      { ...variable, format: "{variable}", value: secret },
      { ...variable, value: secret },
      { _type: "ConfigurationVariable", format: "{variable}" },
      { value: secret },
      [secret],
      42,
      null,
    ]) {
      const errors = validate(inKeys(turnkey({ apiPrivateKey })));
      assert.deepEqual(
        errors.map((error) => error.path),
        ["kms.keys.a.apiPrivateKey"],
        JSON.stringify(errors),
      );
      assert.ok(!JSON.stringify(errors).includes(secret), JSON.stringify(errors));
    }
  });

  it("accepts a variable with Hardhat's own format, or with none", () => {
    for (const apiPrivateKey of [
      configVariable("TURNKEY_API_PRIVATE_KEY"),
      configVariable("TURNKEY_API_PRIVATE_KEY", { format: "{variable}" }),
      { _type: "ConfigurationVariable", name: "TURNKEY_API_PRIVATE_KEY" },
    ]) {
      assert.deepEqual(validate(inKeys(turnkey({ apiPrivateKey }))), []);
    }
  });
});
