// Edge cases that pin down each validation and resolution rule, so that loosening one fails a test.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { HardhatUserConfig } from "hardhat/config";
import { configVariable } from "hardhat/config";
import type { HardhatConfig } from "hardhat/types/config";

import { resolveKmsConfig, resolveKmsUserConfig } from "../../../src/internal/config/resolve.ts";
import { parseAwsKeyId } from "../../../src/internal/providers/aws/key-id.ts";
import {
  parseAzureKeyId,
  parseAzureVaultUrl,
} from "../../../src/internal/providers/azure/key-id.ts";
import type { KmsKeyConfig } from "../../../src/types.ts";
import { assertError, validate } from "../../helpers/config-validation.ts";
import { fakeResolver } from "../../helpers/config-variables.ts";

const KEY_UUID = "1234abcd-12ab-34cd-56ef-1234567890ab";
const GCP_NAME = "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1";
const aws = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  provider: "aws",
  keyId: "alias/a",
  ...extra,
});
const gcpParts = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  provider: "gcp",
  projectId: "p",
  location: "l",
  keyRing: "r",
  keyName: "k",
  keyVersion: 1,
  ...extra,
});
const withKey = (key: unknown, name = "a"): unknown => ({ kms: { keys: { [name]: key } } });

/** Treats a plain object as a resolved config; the resolver reads only `networks`. */
function networksOnly(config: unknown): HardhatConfig {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only `networks` is read
  return config as HardhatConfig;
}

function resolvedKey(
  config: unknown,
  name = "a",
  values: Record<string, string> = {},
): KmsKeyConfig {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test configs are validated separately
  const resolved = resolveKmsConfig(config as HardhatUserConfig, fakeResolver(values)).keys[name];
  assert.ok(resolved);
  return resolved;
}

describe("key names", () => {
  it("accepts 64 characters and rejects 65, or a first character that is not a letter", () => {
    assert.deepEqual(validate(withKey(aws(), `a${"b".repeat(63)}`)), []);
    for (const name of [`a${"b".repeat(64)}`, "1abc", "-a", "_a"]) {
      assertError(withKey(aws(), name), `kms.keys.${name}`, "Key names", 1);
    }
  });
});

describe("kmsAccounts names", () => {
  it("rejects names that exist only on Object.prototype", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty"]) {
      assertError(
        { networks: { n: { kmsAccounts: [name] } } },
        "networks.n.kmsAccounts.0",
        `Unknown key "${name}"`,
        1,
      );
    }
  });

  it("refuses to resolve them either", () => {
    const resolvedConfig: unknown = { networks: { n: { type: "http" } } };
    const userConfig: HardhatUserConfig = {
      networks: { n: { type: "http", url: "http://x", kmsAccounts: ["constructor"] } },
    };

    assert.throws(
      () => resolveKmsUserConfig(userConfig, networksOnly(resolvedConfig), fakeResolver({})),
      /Unknown key "constructor"/,
    );
  });
});

describe("unknown fields", () => {
  it("are errors in kms.defaults, kms.defaults.aws and every built-in key form", () => {
    assertError({ kms: { defaults: { timeoutMS: 1 } } }, "kms.defaults", "timeoutMS", 1);
    assertError({ kms: { defaults: { aws: { regoin: "x" } } } }, "kms.defaults.aws", "regoin", 1);
    assertError(
      withKey({ provider: "gcp", keyVersionName: GCP_NAME, typo: 1 }),
      "kms.keys.a",
      "typo",
      1,
    );
    assertError(withKey(gcpParts({ typo: 1 })), "kms.keys.a", "typo", 1);
    assertError(
      withKey({ provider: "azure", keyId: "https://v.vault.azure.net/keys/k", typo: 1 }),
      "kms.keys.a",
      "typo",
      1,
    );
    assertError(
      withKey({ provider: "azure", vaultUrl: "https://v.vault.azure.net", keyName: "k", typo: 1 }),
      "kms.keys.a",
      "typo",
      1,
    );
  });

  it("include approvalTimeoutMs on AWS, Google Cloud and Azure keys and in kms.defaults", () => {
    const message = "Unrecognized key(s) in object: 'approvalTimeoutMs'";
    const field = { approvalTimeoutMs: 600_000 };
    assertError(withKey(aws(field)), "kms.keys.a", message, 1);
    assertError(withKey(gcpParts(field)), "kms.keys.a", message, 1);
    assertError(
      withKey({ provider: "gcp", keyVersionName: GCP_NAME, ...field }),
      "kms.keys.a",
      message,
      1,
    );
    assertError(
      withKey({ provider: "azure", keyId: "https://v.vault.azure.net/keys/k", ...field }),
      "kms.keys.a",
      message,
      1,
    );
    assertError(
      withKey({ provider: "azure", vaultUrl: "https://v.vault.azure.net", keyName: "k", ...field }),
      "kms.keys.a",
      message,
      1,
    );
    assertError({ kms: { defaults: field } }, "kms.defaults", message, 1);
    assertError(
      {
        networks: {
          n: { type: "http", url: "http://x", kmsAccounts: [aws(field)] },
        },
      },
      "networks.n.kmsAccounts.0",
      message,
      1,
    );
  });

  it("are left to the provider on a third-party key, which gets them in userConfig", () => {
    const userKey = { provider: "myvault", approvalTimeoutMs: 600_000 };
    assert.deepEqual(validate(withKey(userKey)), []);

    const key: unknown = resolvedKey(withKey(userKey));
    assert.ok(typeof key === "object" && key !== null && "userConfig" in key);
    assert.ok(!("approvalTimeoutMs" in key));
    const { userConfig } = key;
    assert.ok(typeof userConfig === "object" && userConfig !== null);
    assert.deepEqual({ ...userConfig }, userKey);
  });

  it("report the misspelled field itself, next to the missing one", () => {
    const errors = validate(withKey({ provider: "aws", keyID: "alias/a" }));

    assert.ok(errors.some((error) => error.path === "kms.keys.a.keyId"));
    assert.ok(
      errors.some((error) => error.path === "kms.keys.a" && error.message.includes("keyID")),
    );
  });
});

describe("string fields", () => {
  it("rejects empty or padded regions and profiles, invalid endpoints and an empty provider", () => {
    assertError(withKey(aws({ region: "" })), "kms.keys.a.region", "non-empty", 1);
    assertError(withKey(aws({ region: " eu-west-1" })), "kms.keys.a.region", "whitespace", 1);
    assertError(withKey(aws({ profile: "" })), "kms.keys.a.profile", "non-empty", 1);
    assertError(
      withKey(aws({ endpoint: "localhost:4566" })),
      "kms.keys.a.endpoint",
      "http or https URL",
      1,
    );
    assertError(
      withKey(aws({ endpoint: "http://user:pass@localhost:4566" })),
      "kms.keys.a.endpoint",
      "without credentials",
      1,
    );
    assertError(withKey({ provider: "" }), "kms.keys.a.provider", "non-empty", 1);
  });
});

describe("AWS key ids", () => {
  it("requires a 12-digit account and a lowercase region in ARNs", () => {
    for (const value of [
      `arn:aws:kms:eu-west-1:11112222333:key/${KEY_UUID}`,
      `arn:aws:kms:eu-west-1:1111222233334:key/${KEY_UUID}`,
      `arn:aws:kms:EU-WEST-1:111122223333:key/${KEY_UUID}`,
      `arn:awsx:kms:eu-west-1:111122223333:key/${KEY_UUID}`,
      `arn:aws-:kms:eu-west-1:111122223333:key/${KEY_UUID}`,
    ]) {
      assert.equal(parseAwsKeyId(value), undefined, value);
    }
  });

  it("limits alias names to 250 characters after alias/", () => {
    assert.equal(parseAwsKeyId(`alias/${"a".repeat(250)}`)?.kind, "aliasName");
    assert.equal(parseAwsKeyId(`alias/${"a".repeat(251)}`), undefined);
  });

  it("uses the ARN's region over the key's and the default region", () => {
    const config = {
      kms: {
        defaults: { aws: { region: "us-east-1" } },
        keys: { arn: aws({ keyId: `arn:aws:kms:eu-west-1:111122223333:key/${KEY_UUID}` }) },
      },
    };

    const key = resolvedKey(config, "arn");

    assert.ok(key.provider === "aws");
    assert.equal(key.region, "eu-west-1");
  });

  it("keeps the configured region for a key id from a variable, and checks a variable ARN against it", async () => {
    const config = {
      kms: { keys: { a: aws({ keyId: configVariable("KEY"), region: "eu-west-1" }) } },
    };
    const inRegion = resolvedKey(config, "a", {
      KEY: `arn:aws:kms:eu-west-1:111122223333:key/${KEY_UUID}`,
    });
    const elsewhere = resolvedKey(config, "a", {
      KEY: `arn:aws:kms:ap-south-1:111122223333:key/${KEY_UUID}`,
    });

    assert.ok(inRegion.provider === "aws" && elsewhere.provider === "aws");
    assert.equal(inRegion.region, "eu-west-1");
    assert.match(await inRegion.keyId.get(), /eu-west-1/);
    await assert.rejects(elsewhere.keyId.get(), /conflicts with `region` \(eu-west-1\)/);
  });
});

describe("GCP versions", () => {
  it("accepts only positive integers, as numbers or strings, in both forms", () => {
    for (const keyVersion of [0, -1, 1.5, "0", "01", "-1"]) {
      assertError(
        withKey(gcpParts({ keyVersion })),
        "kms.keys.a.keyVersion",
        "positive integer",
        1,
      );
    }
    for (const version of ["0", "01", "007"]) {
      assertError(
        withKey({ provider: "gcp", keyVersionName: GCP_NAME.replace(/1$/, version) }),
        "kms.keys.a.keyVersionName",
        "cryptoKeyVersions",
        1,
      );
    }
    assert.deepEqual(validate(withKey(gcpParts({ keyVersion: "12" }))), []);
  });
});

describe("Azure URLs", () => {
  it("rejects a username or a password alone, fragments and vault URLs with a query", () => {
    for (const value of [
      "https://user@ops.vault.azure.net/keys/k",
      "https://:pass@ops.vault.azure.net/keys/k",
      "https://ops.vault.azure.net/keys/k#x",
      "https://ops.vault.azure.net/keys/k?x=1",
    ]) {
      assert.equal(parseAzureKeyId(value), undefined, value);
    }
    for (const value of [
      "https://ops.vault.azure.net/?x=1",
      "https://ops.vault.azure.net/#x",
      "https://user@ops.vault.azure.net",
    ]) {
      assert.equal(parseAzureVaultUrl(value), undefined, value);
    }
  });

  it("accepts every sovereign-cloud suffix, but not a shorter parent domain", () => {
    for (const host of [
      "v.managedhsm.azure.net",
      "v.managedhsm.azure.cn",
      "v.managedhsm.usgovcloudapi.net",
      "v.vault.microsoftazure.de",
      "v.managedhsm.microsoftazure.de",
    ]) {
      assert.deepEqual(
        parseAzureKeyId(`https://${host}/keys/k`),
        { vaultUrl: `https://${host}`, keyName: "k" },
        host,
      );
    }
    for (const host of ["v.microsoftazure.de", "v.azure.net", "v.usgovcloudapi.net"]) {
      assert.equal(parseAzureKeyId(`https://${host}/keys/k`), undefined, host);
    }
  });

  it("lowercases the vault host", () => {
    assert.deepEqual(parseAzureKeyId("https://OPS.Vault.Azure.CN/keys/k"), {
      vaultUrl: "https://ops.vault.azure.cn",
      keyName: "k",
    });
  });

  it("limits key names to 127 characters", () => {
    assert.ok(parseAzureKeyId(`https://v.vault.azure.net/keys/${"k".repeat(127)}`));
    assert.equal(parseAzureKeyId(`https://v.vault.azure.net/keys/${"k".repeat(128)}`), undefined);
  });

  it("drops the vault URL's trailing slash in versioned ids", async () => {
    const key = resolvedKey(
      withKey({
        provider: "azure",
        vaultUrl: "https://ops.vault.azure.net/",
        keyName: "k",
        keyVersion: "v1",
      }),
    );

    assert.ok(key.provider === "azure");
    assert.equal(await key.keyId.get(), "https://ops.vault.azure.net/keys/k/v1");
  });
});

describe("resolution", () => {
  it("lets a key override timeoutMs, and gives inline keys the defaults", () => {
    const userConfig: HardhatUserConfig = {
      kms: {
        defaults: { timeoutMs: 1234 },
        keys: { a: { provider: "aws", keyId: "alias/a", timeoutMs: 5000 } },
        simulatedBalance: 10n ** 18n,
      },
      networks: {
        n: { type: "http", url: "http://x", kmsAccounts: [{ provider: "aws", keyId: "alias/b" }] },
      },
    };
    const resolvedConfig: unknown = { networks: { n: { type: "http" } } };
    const resolved = resolveKmsUserConfig(
      userConfig,
      networksOnly(resolvedConfig),
      fakeResolver({}),
    );
    const inline = resolved.networks.n?.kmsAccounts[0];

    assert.equal(resolved.kms.keys.a?.timeoutMs, 5000);
    assert.equal(inline?.timeoutMs, 1234);
    assert.equal(resolved.kms.simulatedBalance, 10n ** 18n);
  });

  it("trims whitespace around values from configuration variables", async () => {
    const key = resolvedKey(withKey(aws({ keyId: configVariable("KEY") })), "a", {
      KEY: "  alias/a\n",
    });

    assert.ok(key.provider === "aws");
    assert.equal(await key.keyId.get(), "alias/a");
  });

  it("copies a third-party key's config and leaves the user's object untouched", () => {
    const userKey = { provider: "myvault", nested: { value: 1 } };
    const key: unknown = resolvedKey(withKey(userKey));

    assert.ok(typeof key === "object" && key !== null && "userConfig" in key);
    assert.notEqual(key.userConfig, userKey);
    assert.ok(!Object.isFrozen(userKey) && !Object.isFrozen(userKey.nested));
  });
});
