import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Values a user would keep secret, planted where the plugin reads them.
const SECRETS = {
  HHKMS_DEBUG_AWS_KEY_ID: "alias/hhkms-secret-alias",
  HHKMS_DEBUG_GCP_PROJECT: "hhkms-secret-project",
  HHKMS_DEBUG_VAULT_TOKEN: "hhkms-secret-token",
  HHKMS_DEBUG_RPC_URL: "https://rpc.example/v2/hhkms-secret-rpc-key",
};

describe("debug output", () => {
  it("logs every namespace without configuration variable values, tokens or provider error text", () => {
    const result = spawnSync(process.execPath, [path.join(here, "../fixtures/debug-run.ts")], {
      encoding: "utf8",
      env: { ...process.env, ...SECRETS, DEBUG: "hardhat:kms:*", DEBUG_COLORS: "no" },
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = result.stderr;

    // The output is there: each namespace logged something useful.
    for (const expected of [
      "hardhat:kms:config keys: aws:<HHKMS_DEBUG_AWS_KEY_ID>",
      "hardhat:kms:config network sepolia:",
      "hardhat:kms:providers creating the adapter for",
      "hardhat:kms:signer",
      "public key derives to 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      "failed after",
      "(TypeError)",
      "asking for a fresh one",
    ]) {
      assert.ok(output.includes(expected), `expected "${expected}" in:\n${output}`);
    }
    // And no secret is in it.
    for (const secret of [...Object.values(SECRETS), "hhkms-secret", "HHKMS-SECRET-SDK-MESSAGE"]) {
      assert.ok(
        !output.toLowerCase().includes(secret.toLowerCase()),
        `"${secret}" leaked into:\n${output}`,
      );
    }
  });
});
