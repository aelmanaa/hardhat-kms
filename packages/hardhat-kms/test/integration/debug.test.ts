import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Values a user would keep secret, planted where the plugin reads them. The fixture plants more:
// a literal field of a third-party key, and provider error messages, causes and request ids.
const SECRETS = {
  HHKMS_DEBUG_AWS_KEY_ID: "alias/hhkms-secret-alias",
  HHKMS_DEBUG_GCP_PROJECT: "hhkms-secret-project",
  HHKMS_DEBUG_AZURE_VAULT: "https://hhkms-secret-vault.vault.azure.net",
  HHKMS_DEBUG_VAULT_TOKEN: "hhkms-secret-token",
  HHKMS_DEBUG_RPC_URL: "https://rpc.example/v2/hhkms-secret-rpc-key",
};

describe("debug output", () => {
  it("logs config, providers and signing without any planted secret", () => {
    const result = spawnSync(process.execPath, [path.join(here, "../fixtures/debug-run.ts")], {
      encoding: "utf8",
      env: { ...process.env, ...SECRETS, DEBUG: "hardhat:kms:*", DEBUG_COLORS: "no" },
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = result.stderr;

    // Every namespace logged, and signer lines use the configuration's display id, not the adapter's.
    for (const expected of [
      "hardhat:kms:config keys: aws:<HHKMS_DEBUG_AWS_KEY_ID>, gcp:projects/<HHKMS_DEBUG_GCP_PROJECT>/",
      "azure:<HHKMS_DEBUG_AZURE_VAULT>/keys/deployer",
      "hardhat:kms:config network sepolia:",
      "hardhat:kms:config --kms aws: aws:<AWS_KMS_KEY_ID>",
      "hardhat:kms:providers creating the adapter for myvault:vault",
      "cryptoKeys/builtin/cryptoKeyVersions/1: no plugin claimed the key",
      "hardhat:kms:signer aws:<HHKMS_DEBUG_AWS_KEY_ID>: public key derives to 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      "asking for a fresh one",
      "(TypeError)",
      "(HardhatPluginError)",
      "(TimeoutError)",
    ]) {
      assert.ok(output.includes(expected), `expected "${expected}" in:\n${output}`);
    }
    assert.ok(
      !output.includes("fake-key-1"),
      "signer lines must use the configuration's display id",
    );
    assert.ok(
      !output.toLowerCase().includes("hhkms-secret"),
      `a planted secret leaked into:\n${output}`,
    );
  });
});
