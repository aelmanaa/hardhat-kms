import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  it("logs config, providers, SDK loading and signing without any planted secret", () => {
    const project = mkdtempSync(path.join(tmpdir(), "hardhat-kms-debug-"));
    try {
      const sdk = path.join(project, "node_modules", "@aws-sdk", "client-kms");
      mkdirSync(sdk, { recursive: true });
      writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "project" }));
      writeFileSync(
        path.join(sdk, "package.json"),
        JSON.stringify({ name: "@aws-sdk/client-kms", version: "3.0.0" }),
      );
      writeFileSync(path.join(sdk, "index.js"), "exports.fake = true;");

      const result = spawnSync(process.execPath, [path.join(here, "../fixtures/debug-run.ts")], {
        encoding: "utf8",
        env: {
          ...process.env,
          ...SECRETS,
          HHKMS_DEBUG_PROJECT: project,
          DEBUG: "hardhat:kms:*",
          DEBUG_COLORS: "no",
        },
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
        "cryptoKeys/builtin/cryptoKeyVersions/1: using the built-in gcp provider",
        "hardhat:kms:signer aws:<HHKMS_DEBUG_AWS_KEY_ID>: public key derives to 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        "asking for a fresh one",
        "(TypeError)",
        "(HardhatPluginError)",
        "(TimeoutError)",
        `hardhat:kms:providers:sdk loading @aws-sdk/client-kms 3.0.0 from ${path.join("node_modules", "@aws-sdk", "client-kms", "index.js")}`,
      ]) {
        assert.ok(output.includes(expected), `expected "${expected}" in:\n${output}`);
      }
      assert.ok(
        !output.includes("fake-key-1"),
        "signer lines must use the configuration's display id",
      );
      assert.ok(!output.includes(project), "the SDK path is relative to the project");
      assert.ok(
        !output.toLowerCase().includes("hhkms-secret"),
        `a planted secret leaked into:\n${output}`,
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
