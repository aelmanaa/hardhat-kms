import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseAwsKeyId } from "../../../src/internal/providers/aws/key-id.ts";
import {
  parseAzureKeyId,
  parseAzureVaultUrl,
} from "../../../src/internal/providers/azure/key-id.ts";
import {
  gcpKeyVersionName,
  parseGcpKeyVersionName,
} from "../../../src/internal/providers/gcp/key-version-name.ts";

const KEY_UUID = "1234abcd-12ab-34cd-56ef-1234567890ab";

describe("AWS key ids", () => {
  it("accepts every form AWS accepts and reads the region from ARNs", () => {
    assert.deepEqual(parseAwsKeyId(KEY_UUID), { kind: "keyId" });
    assert.deepEqual(parseAwsKeyId(`mrk-${"a".repeat(32)}`), { kind: "keyId" });
    assert.deepEqual(parseAwsKeyId("alias/deployer"), { kind: "aliasName" });
    assert.deepEqual(parseAwsKeyId(`arn:aws:kms:eu-west-1:111122223333:key/${KEY_UUID}`), {
      kind: "keyArn",
      region: "eu-west-1",
    });
    for (const partition of ["aws-cn", "aws-iso-f", "aws-eusc"]) {
      assert.equal(
        parseAwsKeyId(`arn:${partition}:kms:r-1:111122223333:alias/ops`)?.kind,
        "aliasArn",
        partition,
      );
    }
    assert.deepEqual(parseAwsKeyId("arn:aws-us-gov:kms:us-gov-west-1:111122223333:alias/ops"), {
      kind: "aliasArn",
      region: "us-gov-west-1",
    });
  });

  it("rejects everything else", () => {
    for (const value of [
      "",
      "deployer",
      "alias/",
      KEY_UUID.toUpperCase(),
      `arn:aws:kms:eu-west-1:1111:key/${KEY_UUID}`,
      `arn:aws:s3:eu-west-1:111122223333:key/${KEY_UUID}`,
      `arn:aws:kms:eu-west-1:111122223333:key/not-a-key`,
      ` alias/deployer`,
    ]) {
      assert.equal(parseAwsKeyId(value), undefined, value);
    }
  });
});

describe("GCP key version names", () => {
  it("round-trips a key version name", () => {
    const name =
      "projects/my-project/locations/europe-west1/keyRings/ring/cryptoKeys/deployer/cryptoKeyVersions/3";
    const parsed = parseGcpKeyVersionName(name);

    assert.deepEqual(parsed, {
      projectId: "my-project",
      location: "europe-west1",
      keyRing: "ring",
      keyName: "deployer",
      keyVersion: "3",
    });
    assert.equal(parsed && gcpKeyVersionName(parsed), name);
  });

  it("rejects names without a positive integer version or with extra segments", () => {
    for (const value of [
      "projects/p/locations/l/keyRings/r/cryptoKeys/k",
      "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/latest",
      "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/0",
      "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/01",
      "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1/extra",
      "projects//locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
      "projects/../locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
    ]) {
      assert.equal(parseGcpKeyVersionName(value), undefined, value);
    }
  });
});

describe("Azure key ids", () => {
  it("accepts vault and Managed HSM keys, versioned or not, in every cloud", () => {
    assert.deepEqual(parseAzureKeyId("https://ops.vault.azure.net/keys/deployer/0123abcd"), {
      vaultUrl: "https://ops.vault.azure.net",
      keyName: "deployer",
      keyVersion: "0123abcd",
    });
    assert.deepEqual(parseAzureKeyId("https://hsm.managedhsm.azure.net/keys/deployer/"), {
      vaultUrl: "https://hsm.managedhsm.azure.net",
      keyName: "deployer",
    });
    assert.ok(parseAzureKeyId("https://OPS.Vault.Azure.CN/keys/k") !== undefined);
    assert.ok(parseAzureKeyId("https://x.vault.usgovcloudapi.net/keys/k") !== undefined);
  });

  it("rejects hosts that are not Azure vaults, so a key id cannot redirect requests", () => {
    for (const value of [
      "https://evil.example/keys/deployer",
      "https://ops.vault.azure.net.evil.example/keys/deployer",
      "https://vault.azure.net/keys/deployer",
      "https://.vault.azure.net/keys/deployer",
      "http://ops.vault.azure.net/keys/deployer",
      "https://ops.vault.azure.net:8443/keys/deployer",
      "https://user:pass@ops.vault.azure.net/keys/deployer",
      "https://ops.vault.azure.net/keys/deployer?api-version=7.4",
      "https://ops.vault.azure.net/secrets/deployer",
      "https://ops.vault.azure.net/keys/deployer/v1/extra",
      "https://ops.vault.azure.net/keys/bad_name",
      "https://ops.vault.azure.net/keys/k?",
      "https://ops.vault.azure.net/keys/k#",
      "https://ops.vault.azure.net\\keys\\k",
      "not a url",
    ]) {
      assert.equal(parseAzureKeyId(value), undefined, value);
    }
  });

  it("parses vault URLs with no path", () => {
    assert.equal(parseAzureVaultUrl("https://ops.vault.azure.net/"), "https://ops.vault.azure.net");
    assert.equal(parseAzureVaultUrl("https://ops.vault.azure.net/keys"), undefined);
    assert.equal(parseAzureVaultUrl("https://evil.example"), undefined);
    for (const value of [
      "https://ops.vault.azure.net/?",
      "https://ops.vault.azure.net/#",
      "https://ops.vault.azure.net\\",
    ]) {
      assert.equal(parseAzureVaultUrl(value), undefined, value);
    }
  });
});
