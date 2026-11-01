import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { HardhatUserConfig } from "hardhat/config";
import { configVariable } from "hardhat/config";
import type { HardhatConfig } from "hardhat/types/config";

import { resolveKmsConfig, resolveKmsUserConfig } from "../../../src/internal/config/resolve.ts";
import { BUILTIN_PROVIDERS } from "../../../src/internal/providers/registry.ts";
import type {
  AwsKmsKeyConfig,
  AzureKmsKeyConfig,
  ExternalKmsKeyConfig,
  GcpKmsKeyConfig,
  KmsKeyConfig,
} from "../../../src/types.ts";
import { fakeResolver } from "../../helpers/config-variables.ts";

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const resolver = fakeResolver({
  AWS_KMS_KEY_ID: "alias/secret-name",
  GCP_PROJECT_ID: "secret-project",
  AZURE_VAULT_URL: "https://secret.vault.azure.net/",
});

function key(config: HardhatUserConfig, name: string): KmsKeyConfig {
  const resolved = resolveKmsConfig(config, resolver).keys[name];
  assert.ok(resolved, `key ${name} was not resolved`);
  return resolved;
}

const isAws = (k: KmsKeyConfig): k is AwsKmsKeyConfig => k.provider === "aws" && "keyId" in k;
const isGcp = (k: KmsKeyConfig): k is GcpKmsKeyConfig =>
  k.provider === "gcp" && "keyVersionName" in k;
const isAzure = (k: KmsKeyConfig): k is AzureKmsKeyConfig => k.provider === "azure" && "keyId" in k;
const isResolvedVariable = (value: unknown): value is { get(): Promise<string> } =>
  typeof value === "object" && value !== null && "get" in value && typeof value.get === "function";
const isExternal = (k: unknown): k is ExternalKmsKeyConfig =>
  typeof k === "object" && k !== null && "userConfig" in k;

function awsKey(config: HardhatUserConfig, name: string): AwsKmsKeyConfig {
  const k = key(config, name);
  assert.ok(isAws(k));
  return k;
}
function gcpKey(config: HardhatUserConfig, name: string): GcpKmsKeyConfig {
  const k = key(config, name);
  assert.ok(isGcp(k));
  return k;
}
function azureKey(config: HardhatUserConfig, name: string): AzureKmsKeyConfig {
  const k = key(config, name);
  assert.ok(isAzure(k));
  return k;
}

describe("resolveKmsConfig", () => {
  it("applies defaults", () => {
    const kms = resolveKmsConfig({}, resolver);

    assert.deepEqual(kms, {
      keys: {},
      defaults: { aws: {}, timeoutMs: 30_000 },
      allowCrossChainTypedData: false,
      audit: {},
    });
  });

  it("checksums the address pin and lets key timeouts override the defaults", () => {
    const config: HardhatUserConfig = {
      kms: {
        defaults: { timeoutMs: 10_000 },
        keys: {
          pinned: {
            provider: "aws",
            keyId: "alias/a",
            address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
            timeoutMs: 5000,
          },
          plain: { provider: "aws", keyId: "alias/b" },
        },
      },
    };
    const pinned = awsKey(config, "pinned");
    const plain = awsKey(config, "plain");

    assert.equal(pinned.address, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    assert.equal(pinned.timeoutMs, 5000);
    assert.equal(plain.timeoutMs, 10_000);
    assert.equal("address" in plain, false);
  });

  it("keeps allowRawDigests only when it is true, for every provider", () => {
    const config: HardhatUserConfig = {
      kms: {
        keys: {
          aws: { provider: "aws", keyId: "alias/a", allowRawDigests: true },
          gcp: {
            provider: "gcp",
            keyVersionName: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
            allowRawDigests: true,
          },
          azure: {
            provider: "azure",
            keyId: "https://v.vault.azure.net/keys/k/1",
            allowRawDigests: true,
          },
          turnkey: {
            provider: "turnkey",
            organizationId: "5f4b4a4e-2a83-4f49-9c41-7d0b1a3e6d10",
            address: ADDRESS,
            apiPrivateKey: configVariable("TURNKEY_API_PRIVATE_KEY"),
            allowRawDigests: true,
          },
          off: { provider: "aws", keyId: "alias/b", allowRawDigests: false },
          unset: { provider: "aws", keyId: "alias/c" },
        },
      },
    };
    for (const name of ["aws", "gcp", "azure", "turnkey"]) {
      assert.equal(key(config, name).allowRawDigests, true, name);
    }
    assert.equal("allowRawDigests" in key(config, "off"), false);
    assert.equal("allowRawDigests" in key(config, "unset"), false);
    const external = resolveKmsConfig(
      { kms: { keys: { v: { provider: "myvault", name: "v", allowRawDigests: true } } } },
      resolver,
    ).keys.v;
    assert.equal(external?.allowRawDigests, true);
  });

  it("keeps the AWS profile and endpoint", async () => {
    const aws = awsKey(
      {
        kms: {
          keys: {
            a: {
              provider: "aws",
              keyId: "alias/a",
              profile: "ci",
              endpoint: "http://localhost:4566",
            },
          },
        },
      },
      "a",
    );

    assert.equal(aws.profile?.display, "ci");
    assert.equal(await aws.profile.get(), "ci");
    assert.equal(aws.endpoint, "http://localhost:4566");
  });

  it("refuses to resolve a key with a provider's resolver for another provider", () => {
    const context = {
      name: "a",
      path: "kms.keys.a",
      resolveVariable: resolver,
      defaults: { aws: {}, timeoutMs: 1 },
    };
    const gcpUserKey = {
      provider: "gcp" as const,
      keyVersionName: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
    };
    const awsUserKey = { provider: "aws" as const, keyId: "alias/a" };

    assert.throws(
      () => BUILTIN_PROVIDERS.aws?.resolve(gcpUserKey, context),
      /Expected a "aws" key, got "gcp"/,
    );
    assert.throws(
      () => BUILTIN_PROVIDERS.gcp?.resolve(awsUserKey, context),
      /Expected a "gcp" key/,
    );
    assert.throws(
      () => BUILTIN_PROVIDERS.azure?.resolve(awsUserKey, context),
      /Expected a "azure" key/,
    );
    assert.throws(
      () => BUILTIN_PROVIDERS.turnkey?.resolve(awsUserKey, context),
      /Expected a "turnkey" key, got "aws"/,
    );
  });

  it("resolves the AWS region: ARN, then key, then defaults", async () => {
    const config: HardhatUserConfig = {
      kms: {
        defaults: { aws: { region: "us-east-1" } },
        keys: {
          arn: {
            provider: "aws",
            keyId: "arn:aws:kms:eu-west-1:111122223333:alias/a",
            region: "eu-west-1",
          },
          key: { provider: "aws", keyId: "alias/a", region: "eu-central-1" },
          fallback: { provider: "aws", keyId: "alias/a" },
        },
      },
    };

    assert.equal(await awsKey(config, "arn").region?.get(), "eu-west-1");
    assert.equal(await awsKey(config, "key").region?.get(), "eu-central-1");
    assert.equal(await awsKey(config, "fallback").region?.get(), "us-east-1");
    assert.equal(awsKey(config, "fallback").region?.display, "us-east-1");
  });

  it("never displays a configuration variable's value, but reads it on demand", async () => {
    const aws = awsKey(
      { kms: { keys: { a: { provider: "aws", keyId: configVariable("AWS_KMS_KEY_ID") } } } },
      "a",
    );

    assert.equal(aws.displayId, "aws:<AWS_KMS_KEY_ID>");
    assert.equal(aws.keyId.display, "<AWS_KMS_KEY_ID>");
    assert.equal(await aws.keyId.get(), "alias/secret-name");
    assert.ok(!JSON.stringify(aws).includes("secret-name"));
  });

  it("builds GCP key version names from components, masking variable parts", async () => {
    const gcp = gcpKey(
      {
        kms: {
          keys: {
            a: {
              provider: "gcp",
              projectId: configVariable("GCP_PROJECT_ID"),
              location: "europe-west1",
              keyRing: "ring",
              keyName: "deployer",
              keyVersion: 3,
            },
          },
        },
      },
      "a",
    );

    assert.equal(
      gcp.displayId,
      "gcp:projects/<GCP_PROJECT_ID>/locations/europe-west1/keyRings/ring/cryptoKeys/deployer/cryptoKeyVersions/3",
    );
    assert.equal(
      await gcp.keyVersionName.get(),
      "projects/secret-project/locations/europe-west1/keyRings/ring/cryptoKeys/deployer/cryptoKeyVersions/3",
    );
  });

  it("builds Azure key ids from components, versioned or not", async () => {
    const config: HardhatUserConfig = {
      kms: {
        keys: {
          unversioned: {
            provider: "azure",
            vaultUrl: configVariable("AZURE_VAULT_URL"),
            keyName: "deployer",
          },
          versioned: {
            provider: "azure",
            vaultUrl: "https://ops.vault.azure.net",
            keyName: "deployer",
            keyVersion: "abc123",
          },
        },
      },
    };
    const unversioned = azureKey(config, "unversioned");

    assert.equal(unversioned.displayId, "azure:<AZURE_VAULT_URL>/keys/deployer");
    assert.equal(await unversioned.keyId.get(), "https://secret.vault.azure.net/keys/deployer");
    assert.equal(
      await azureKey(config, "versioned").keyId.get(),
      "https://ops.vault.azure.net/keys/deployer/abc123",
    );
  });

  it("keeps a third-party key's config, with configuration variables resolved, for its provider", async () => {
    const userConfig: unknown = {
      kms: {
        keys: {
          v: {
            provider: "myvault",
            keyPath: "a/b",
            auth: { token: configVariable("AWS_KMS_KEY_ID") },
          },
        },
      },
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a provider this package does not know
    const external: unknown = key(userConfig as HardhatUserConfig, "v");
    assert.ok(isExternal(external));

    assert.equal(external.provider, "myvault");
    assert.equal(external.userConfig.keyPath, "a/b");
    assert.equal(external.displayId, "myvault:v");
    assert.ok(Object.isFrozen(external.userConfig));
    const auth = external.userConfig.auth;
    assert.ok(typeof auth === "object" && auth !== null && Object.isFrozen(auth));
    const token: unknown = "token" in auth ? auth.token : undefined;
    assert.ok(isResolvedVariable(token));
    assert.equal(await token.get(), "alias/secret-name");
  });

  it("lets consumers narrow a resolved key on its provider", () => {
    assert.equal(
      describeKey(awsKey({ kms: { keys: { a: { provider: "aws", keyId: "alias/a" } } } }, "a")),
      "aws:alias/a",
    );
  });
});

// Compiles only if `provider` narrows the union: `keyVersionName` exists on GCP keys alone, and
// `organizationId` on Turnkey keys alone.
function describeKey(k: KmsKeyConfig): string {
  if (k.provider === "turnkey") {
    return `turnkey:${k.organizationId.display}/${k.address}`;
  }
  return k.provider === "gcp" ? k.keyVersionName.display : `${k.provider}:${k.keyId.display}`;
}

const resolveWith = (
  config: HardhatUserConfig,
  values: Record<string, string>,
  name = "a",
): KmsKeyConfig => {
  const resolved = resolveKmsConfig(config, fakeResolver(values)).keys[name];
  assert.ok(resolved);
  return resolved;
};
const getOf = async (k: KmsKeyConfig): Promise<string> =>
  await (k.provider === "gcp"
    ? k.keyVersionName.get()
    : k.provider === "turnkey"
      ? k.organizationId.get()
      : k.keyId.get());

const awsVariableConfig = (region: string | undefined): HardhatUserConfig => ({
  kms: {
    keys: {
      a: {
        provider: "aws",
        keyId: configVariable("KEY"),
        ...(region === undefined ? {} : { region }),
      },
    },
  },
});

/** A resolved Hardhat config with only `networks`, which is all the resolver reads. */
function networksOnly(networks: Record<string, unknown>): HardhatConfig {
  const config: unknown = { networks };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only `networks` is read
  return config as HardhatConfig;
}

async function assertRejectsWithout(
  k: KmsKeyConfig,
  includes: string[],
  secret: string,
): Promise<void> {
  await assert.rejects(getOf(k), (error: unknown) => {
    assert.ok(error instanceof Error);
    for (const part of includes) {
      assert.ok(error.message.includes(part), `"${error.message}" should include "${part}"`);
    }
    assert.ok(!error.message.includes(secret), `"${error.message}" must not include the value`);
    return true;
  });
}

describe("values from configuration variables", () => {
  it("checks an AWS key id, and its ARN region against `region`, when read", async () => {
    const arn = "arn:aws:kms:eu-west-1:111122223333:alias/deployer";

    assert.equal(await getOf(resolveWith(awsVariableConfig(undefined), { KEY: arn })), arn);
    await assertRejectsWithout(
      resolveWith(awsVariableConfig(undefined), { KEY: "not-a-key" }),
      ["kms.keys.a.keyId", "<KEY>", "alias name"],
      "not-a-key",
    );
    await assertRejectsWithout(
      resolveWith(awsVariableConfig("us-east-1"), { KEY: arn }),
      ["conflicts", "us-east-1"],
      "111122223333",
    );
  });

  it("checks a joined GCP key version name when read", async () => {
    const config: HardhatUserConfig = {
      kms: {
        keys: {
          a: {
            provider: "gcp",
            projectId: "p",
            location: "l",
            keyRing: configVariable("RING"),
            keyName: "k",
            keyVersion: 1,
          },
        },
      },
    };

    assert.match(await getOf(resolveWith(config, { RING: "ring" })), /keyRings\/ring\//);
    await assertRejectsWithout(
      resolveWith(config, { RING: "../../x" }),
      ["kms.keys.a.keyRing (<RING>)", "not `.` or `..`"],
      "../../x",
    );
  });

  it("checks an Azure key id's host when read, so a variable cannot redirect signing requests", async () => {
    const byId: HardhatUserConfig = {
      kms: { keys: { a: { provider: "azure", keyId: configVariable("AZ") } } },
    };
    const byVault: HardhatUserConfig = {
      kms: { keys: { a: { provider: "azure", vaultUrl: configVariable("VAULT"), keyName: "k" } } },
    };

    assert.equal(
      await getOf(resolveWith(byId, { AZ: "https://ops.vault.azure.net/keys/k" })),
      "https://ops.vault.azure.net/keys/k",
    );
    await assertRejectsWithout(
      resolveWith(byId, { AZ: "https://attacker.example/keys/k" }),
      ["kms.keys.a.keyId", "<AZ>"],
      "attacker",
    );
    assert.equal(
      await getOf(resolveWith(byVault, { VAULT: "https://ops.vault.azure.net/" })),
      "https://ops.vault.azure.net/keys/k",
    );
    for (const bad of [
      "https://ops.vault.azure.net/?",
      "https://ops.vault.azure.net/#",
      "https://attacker.example",
    ]) {
      await assertRejectsWithout(
        resolveWith(byVault, { VAULT: bad }),
        ["kms.keys.a", "<VAULT>/keys/k"],
        "attacker",
      );
    }
  });

  it("resolves a Turnkey key: checksummed pin, display id and API keys by variable name", async () => {
    const organization = "F81D4FAE-7DEC-11D0-A765-00A0C91E6BF6";
    const values = {
      TK_ORG: ` ${organization} `,
      TK_PRIVATE: "hhkms-secret-api-private-key",
      TK_PUBLIC: "hhkms-secret-api-public-key",
    };
    const fromVariables = resolveWith(
      {
        kms: {
          keys: {
            a: {
              provider: "turnkey",
              organizationId: configVariable("TK_ORG"),
              address: ADDRESS.toLowerCase(),
              apiPrivateKey: configVariable("TK_PRIVATE"),
              apiPublicKey: configVariable("TK_PUBLIC"),
            },
          },
        },
      },
      values,
    );
    assert.ok(fromVariables.provider === "turnkey");
    assert.equal(fromVariables.address, ADDRESS);
    assert.equal(fromVariables.displayId, `turnkey:<TK_ORG>/${ADDRESS}`);
    assert.equal(fromVariables.timeoutMs, 30_000);
    assert.equal(fromVariables.transactionSigning, "transaction");
    assert.equal(await fromVariables.organizationId.get(), organization);
    assert.equal(fromVariables.apiPrivateKey.display, "<TK_PRIVATE>");
    assert.equal(await fromVariables.apiPrivateKey.get(), values.TK_PRIVATE);
    assert.equal(fromVariables.apiPublicKey?.display, "<TK_PUBLIC>");
    assert.equal(await fromVariables.apiPublicKey?.get(), values.TK_PUBLIC);
    assert.ok(!JSON.stringify(fromVariables).includes("hhkms-secret"));

    const literal = resolveWith(
      {
        kms: {
          keys: {
            a: {
              provider: "turnkey",
              organizationId: organization,
              address: ADDRESS,
              apiPrivateKey: configVariable("TK_PRIVATE"),
              timeoutMs: 5,
              transactionSigning: "digest",
            },
          },
        },
      },
      values,
    );
    assert.ok(literal.provider === "turnkey");
    assert.equal(literal.displayId, `turnkey:${organization}/${ADDRESS}`);
    assert.equal(literal.timeoutMs, 5);
    assert.equal(literal.transactionSigning, "digest");
    assert.equal(literal.apiPublicKey, undefined);
    assert.ok(!Object.hasOwn(literal, "apiPublicKey"));
  });

  it("checks a Turnkey organization id from a variable when read", async () => {
    const config: HardhatUserConfig = {
      kms: {
        keys: {
          a: {
            provider: "turnkey",
            organizationId: configVariable("TK_ORG"),
            address: ADDRESS,
            apiPrivateKey: configVariable("TK_PRIVATE"),
          },
        },
      },
    };
    await assertRejectsWithout(
      resolveWith(config, { TK_ORG: "hhkms-secret-organization" }),
      [
        "invalid value for kms.keys.a.organizationId (<TK_ORG>): expected a Turnkey organization id, a UUID",
      ],
      "hhkms-secret",
    );
  });

  it("names the network path for inline keys", async () => {
    const userConfig: HardhatUserConfig = {
      networks: {
        sepolia: {
          type: "http",
          url: "http://x",
          kmsAccounts: [{ provider: "aws", keyId: configVariable("KEY") }],
        },
      },
    };
    const resolved = resolveKmsUserConfig(
      userConfig,
      networksOnly({ sepolia: { type: "http" } }),
      fakeResolver({ KEY: "nope" }),
    );
    const account = resolved.networks.sepolia?.kmsAccounts[0];
    assert.ok(account);

    await assertRejectsWithout(account, ["networks.sepolia.kmsAccounts.0.keyId"], "nope");
  });
});

describe("resolveKmsUserConfig", () => {
  const resolvedBase = networksOnly({
    default: { type: "edr-simulated" },
    sepolia: { type: "http", chainId: 11155111 },
  });

  it("expands key names, resolves inline keys and gives every network kmsAccounts", () => {
    const userConfig: HardhatUserConfig = {
      kms: { keys: { deployer: { provider: "aws", keyId: "alias/deployer" } } },
      networks: {
        sepolia: {
          type: "http",
          url: "http://x",
          kmsAccounts: ["deployer", { provider: "aws", keyId: "alias/ops" }],
        },
      },
    };
    const resolved = resolveKmsUserConfig(userConfig, resolvedBase, resolver);
    const sepolia = resolved.networks.sepolia;
    const accounts = sepolia?.kmsAccounts ?? [];

    assert.equal(accounts.length, 2);
    assert.equal(accounts[0], resolved.kms.keys.deployer);
    assert.equal(accounts[1]?.name, "sepolia.kmsAccounts[1]");
    assert.equal(accounts[1]?.displayId, "aws:alias/ops");
    assert.deepEqual(resolved.networks.default?.kmsAccounts, []);
    assert.equal(sepolia?.type, "http");
  });

  it("refuses to resolve an unknown key name", () => {
    const userConfig: HardhatUserConfig = {
      networks: { sepolia: { type: "http", url: "http://x", kmsAccounts: ["nope"] } },
    };

    assert.throws(
      () => resolveKmsUserConfig(userConfig, resolvedBase, resolver),
      /Unknown key "nope"/,
    );
  });
});
