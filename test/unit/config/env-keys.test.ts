import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardhatPluginError } from "hardhat/plugins";

import { keysFromKmsOption, parseKmsOption } from "../../../src/internal/config/env-keys.ts";
import type { KmsKeyConfig } from "../../../src/types.ts";

const DEFAULTS = { aws: { region: "eu-west-1" }, timeoutMs: 1234 };
const GCP_ENV = {
  GCP_PROJECT_ID: "my-project",
  GCP_LOCATION: "europe-west1",
  GCP_KEY_RING: "ring",
  GCP_KEY_NAME: "deployer",
  GCP_KEY_VERSION: "3",
};

async function assertKmsError(
  promise: Promise<unknown> | (() => unknown),
  includes: string[],
  excludes: string[] = [],
) {
  const check = (error: unknown): boolean => {
    assert.ok(error instanceof HardhatPluginError, String(error));
    for (const part of includes) {
      assert.ok(error.message.includes(part), `"${error.message}" should include "${part}"`);
    }
    for (const part of excludes) {
      assert.ok(!error.message.includes(part), `"${error.message}" must not include "${part}"`);
    }
    return true;
  };
  if (typeof promise === "function") {
    assert.throws(promise, check);
  } else {
    await assert.rejects(promise, check);
  }
}

const idOf = (key: KmsKeyConfig): Promise<string> =>
  key.provider === "gcp" ? key.keyVersionName.get() : key.keyId.get();

describe("parseKmsOption", () => {
  it("reads a comma-separated list of built-in providers", () => {
    assert.deepEqual(parseKmsOption("aws"), ["aws"]);
    assert.deepEqual(parseKmsOption(" azure , aws "), ["azure", "aws"]);
  });

  it("rejects empty values, duplicates, unknown and misspelled providers", async () => {
    await assertKmsError(
      () => parseKmsOption(" , "),
      ["expected one or more of aws, gcp and azure"],
    );
    await assertKmsError(() => parseKmsOption("aws,aws"), ["--kms aws: listed twice"]);
    await assertKmsError(
      () => parseKmsOption("awz"),
      ['--kms awz: unknown provider. Did you mean "aws"?'],
    );
    await assertKmsError(
      () => parseKmsOption("turnkey"),
      ["--kms turnkey: unknown provider. Expected aws, gcp or azure"],
    );
  });
});

describe("keysFromKmsOption", () => {
  it("reads one AWS key, names it after its variable and never shows its value", async () => {
    const [key, ...rest] = await keysFromKmsOption(
      "aws",
      { AWS_KMS_KEY_ID: " alias/deployer " },
      DEFAULTS,
    );

    assert.equal(rest.length, 0);
    assert.ok(key?.provider === "aws");
    assert.equal(key.name, "AWS_KMS_KEY_ID");
    assert.equal(key.displayId, "aws:<AWS_KMS_KEY_ID>");
    assert.equal(await key.keyId.get(), "alias/deployer");
    assert.ok(!JSON.stringify(key).includes("deployer"));
  });

  it("prefers the list variable, trims entries and drops blank ones", async () => {
    const keys = await keysFromKmsOption(
      "aws",
      { AWS_KMS_KEY_IDS: " alias/a, ,alias/b ", AWS_KMS_KEY_ID: "alias/ignored" },
      DEFAULTS,
    );

    assert.deepEqual(
      keys.map((key) => key.displayId),
      ["aws:<AWS_KMS_KEY_IDS[0]>", "aws:<AWS_KMS_KEY_IDS[1]>"],
    );
    assert.deepEqual(await Promise.all(keys.map(idOf)), ["alias/a", "alias/b"]);
  });

  it("inherits kms.defaults", async () => {
    const [key] = await keysFromKmsOption("aws", { AWS_KMS_KEY_ID: "alias/a" }, DEFAULTS);

    assert.ok(key?.provider === "aws");
    assert.equal(key.region, "eu-west-1");
    assert.equal(key.timeoutMs, 1234);
  });

  it("says which variable to set", async () => {
    await assertKmsError(keysFromKmsOption("aws", {}, DEFAULTS), [
      "--kms aws: set AWS_KMS_KEY_ID, or AWS_KMS_KEY_IDS for several keys",
    ]);
    await assertKmsError(keysFromKmsOption("aws", { AWS_KMS_KEY_IDS: " , " }, DEFAULTS), [
      "--kms aws: AWS_KMS_KEY_IDS is set but holds no key ids",
    ]);
    await assertKmsError(keysFromKmsOption("azure", { AZURE_KEY_VAULT_KEY_ID: "  " }, DEFAULTS), [
      "--kms azure: set AZURE_KEY_VAULT_KEY_ID, or AZURE_KEY_VAULT_KEY_IDS for several keys",
    ]);
    const { GCP_KEY_RING: _unused, ...withoutRing } = GCP_ENV;
    await assertKmsError(keysFromKmsOption("gcp", withoutRing, DEFAULTS), [
      "--kms gcp: GCP_KEY_RING is not set",
    ]);
  });

  it("checks values with the config's rules and names the variable, not the value", async () => {
    await assertKmsError(
      keysFromKmsOption("aws", { AWS_KMS_KEY_ID: "hhkms-secret-not-a-key" }, DEFAULTS),
      ["invalid value for --kms aws.keyId (<AWS_KMS_KEY_ID>)"],
      ["hhkms-secret"],
    );
    await assertKmsError(
      keysFromKmsOption(
        "azure",
        { AZURE_KEY_VAULT_KEY_ID: "https://hhkms-secret.example/keys/k" },
        DEFAULTS,
      ),
      ["(<AZURE_KEY_VAULT_KEY_ID>)", "Azure Key Vault"],
      ["hhkms-secret"],
    );
    await assertKmsError(
      keysFromKmsOption("gcp", { ...GCP_ENV, GCP_KEY_VERSION: "0" }, DEFAULTS),
      ["projects/<GCP_PROJECT_ID>/locations/<GCP_LOCATION>"],
      ["my-project"],
    );
  });

  it("builds a GCP key from the five variables and Azure keys from their ids", async () => {
    const keys = await keysFromKmsOption(
      "gcp,azure",
      {
        ...GCP_ENV,
        AZURE_KEY_VAULT_KEY_IDS:
          "https://ops.vault.azure.net/keys/a,https://ops.vault.azure.net/keys/b/v1",
      },
      DEFAULTS,
    );

    assert.deepEqual(
      keys.map((key) => key.name),
      ["GCP_KEY_*", "AZURE_KEY_VAULT_KEY_IDS[0]", "AZURE_KEY_VAULT_KEY_IDS[1]"],
    );
    assert.equal(
      keys[0]?.displayId,
      "gcp:projects/<GCP_PROJECT_ID>/locations/<GCP_LOCATION>/keyRings/<GCP_KEY_RING>/cryptoKeys/<GCP_KEY_NAME>/cryptoKeyVersions/<GCP_KEY_VERSION>",
    );
    assert.deepEqual(await Promise.all(keys.map(idOf)), [
      "projects/my-project/locations/europe-west1/keyRings/ring/cryptoKeys/deployer/cryptoKeyVersions/3",
      "https://ops.vault.azure.net/keys/a",
      "https://ops.vault.azure.net/keys/b/v1",
    ]);
  });

  it("reads only the variables of the providers named", async () => {
    // AWS variables are set but not asked for; the GCP ones are asked for but missing.
    await assertKmsError(keysFromKmsOption("gcp", { AWS_KMS_KEY_ID: "alias/a" }, DEFAULTS), [
      "GCP_PROJECT_ID is not set",
    ]);
  });
});
