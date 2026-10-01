// The live tests' redaction, with made-up identifiers of every kind. Runs offline, in `pnpm test`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redact, secretsOf } from "./helpers/redact.ts";

const KEY_UUID = "1234abcd-12ab-34cd-56ef-1234567890ab";
const ENV = {
  HARDHAT_KMS_LIVE_AWS_KEY_ID: `arn:aws:kms:us-east-1:111122223333:key/${KEY_UUID}`,
  HARDHAT_KMS_LIVE_GCP_KEY:
    "projects/fake-project-42/locations/europe-west1/keyRings/fake-ring/cryptoKeys/fake-key/cryptoKeyVersions/3",
  HARDHAT_KMS_LIVE_AZURE_KEY_ID:
    "https://fakevault.vault.azure.net/keys/fake-azure-key/0123456789abcdef0123456789abcdef",
  HARDHAT_KMS_LIVE_SEPOLIA_RPC_URL: "https://sepolia.example.org/v2/fake-api-key",
};

/** Fails if any made-up identifier survives in the redacted message. */
function assertClean(message: string): string {
  const text = redact(message, ENV);
  for (const secret of [
    KEY_UUID,
    "111122223333",
    "fake-project-42",
    "fake-ring",
    "fake-key",
    "fakevault",
    "fake-azure-key",
    "0123456789abcdef0123456789abcdef",
    "fake-api-key",
    "sepolia.example.org",
    "987654321098",
    "424242",
    "alias/live-key",
    "other-vault",
    "fffffffe-0000-4000-8000-000000000001",
  ]) {
    assert.ok(!text.includes(secret), `"${secret}" survived in: ${text}`);
  }
  return text;
}

describe("live test redaction", () => {
  it("splits each key variable into the parts it removes", () => {
    const secrets = secretsOf(ENV);
    for (const part of [KEY_UUID, "111122223333", "fake-project-42", "fakevault", "fake-key"]) {
      assert.ok(secrets.includes(part), `${part} is not removed`);
    }
    for (const reserved of ["arn", "aws", "kms", "key", "projects", "keys"]) {
      assert.ok(!secrets.includes(reserved), `${reserved} would be removed`);
    }
    assert.deepEqual(
      secrets,
      secrets.toSorted((a, b) => b.length - a.length),
      "not longest first",
    );
  });

  it("removes AWS key ids, ARNs, aliases, account and principal ids", () => {
    const text = assertClean(
      `AccessDeniedException: User: arn:aws:iam::987654321098:user/dev is not authorized to perform kms:Sign on resource arn:aws:kms:us-east-1:111122223333:key/${KEY_UUID}; ` +
        `key ${KEY_UUID}, alias/live-key ARN arn:aws:kms:us-east-1:111122223333:alias/live-key, principal fffffffe-0000-4000-8000-000000000001`,
    );
    assert.match(text, /<arn>/);
    assert.match(text, /<redacted>|<uuid>/);
  });

  it("removes GCP key names and project numbers", () => {
    assertClean(
      `PERMISSION_DENIED: Permission 'cloudkms.cryptoKeyVersions.useToSign' denied on resource '${ENV.HARDHAT_KMS_LIVE_GCP_KEY}'; ` +
        "Cloud KMS API has not been used in project 424242 before, or projects/424242 is disabled",
    );
  });

  it("removes Azure vaults, key names, versions and the key vault form", () => {
    assertClean(
      `Forbidden: The user does not have keys sign permission on key vault 'fakevault;location=eastus'. ` +
        `Key ${ENV.HARDHAT_KMS_LIVE_AZURE_KEY_ID} on fakevault.vault.azure.net, version 0123456789abcdef0123456789abcdef; ` +
        "also key vault 'other-vault;location=westeurope'",
    );
  });

  it("removes the RPC URL, any URL and API-key paths", () => {
    const text = assertClean(
      `HTTP request failed. URL: ${ENV.HARDHAT_KMS_LIVE_SEPOLIA_RPC_URL} Status: 429; ` +
        "retry wss://sepolia.example.org/ws or sepolia.example.org/v2/fake-api-key",
    );
    assert.match(text, /<url>/);
  });

  it("keeps addresses and transaction hashes", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const address = "0x728743B36DE6236f6d03409563a7E2c39a00EE17";
    assert.equal(redact(`${address} sent ${hash}`, ENV), `${address} sent ${hash}`);
  });

  it("removes raw transactions, signatures and authorizations' r and s", () => {
    const raw = `0x02f8${"5a".repeat(110)}`;
    const signature = `0x${"1c".repeat(65)}`;
    const r = `0x${"0d".repeat(32)}`;
    const s = `0x${"7e".repeat(31)}`;
    const text = redact(
      `eth_sendRawTransaction failed: ${raw}; signature ${signature}; ` +
        `authorization {"chainId":"0xaa36a7","nonce":"0x5","yParity":"0x1","r":"${r}","s":"${s}"}; r: ${r}, s=${s}`,
      ENV,
    );
    for (const value of [raw, signature, r, s, "5a5a5a", "1c1c1c", "0d0d0d", "7e7e7e"]) {
      assert.ok(!text.includes(value), `${value} survived in: ${text}`);
    }
    assert.match(text, /<signed data>/);
    assert.match(text, /"r":"<signature>"/);
    assert.match(text, /"nonce":"0x5"/);
  });
});
