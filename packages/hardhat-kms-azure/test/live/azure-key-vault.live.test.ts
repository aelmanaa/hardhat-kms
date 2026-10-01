// Runs the Azure adapter against a real Azure Key Vault or Managed HSM key:
// `pnpm run test:live:azure`. It is skipped unless HARDHAT_KMS_LIVE_AZURE_KEY_ID holds the
// versioned URL of the current version of an EC P-256K key, such as
// https://<vault>.vault.azure.net/keys/<name>/<version>. It signs with the developer's own
// credentials, through the plugin's credential chain (`az login` is enough), and creates nothing.
// The vault host, key name and version are redacted from every failure it reports.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { AzureKmsKeyUserConfig, KmsKeyAdapter } from "hardhat-kms/types";

import { checkSignature, signContext, signDigest, withAdapter } from "../helpers/plugin-adapter.ts";

const keyId = process.env.HARDHAT_KMS_LIVE_AZURE_KEY_ID?.trim() ?? "";
const match = /^(https:\/\/[^/]+)\/keys\/([^/]+)\/([^/]+)$/.exec(keyId);
const [, vaultUrl = "", keyName = "", keyVersion = ""] = match ?? [];

/** Removes the vault, key name and version from a message. */
function redact(message: string): string {
  const replacements: Array<[string, string]> = [
    [vaultUrl, "<vault>"],
    [vaultUrl.replace(/^https:\/\//, ""), "<vault host>"],
    [keyVersion, "<version>"],
    [keyName, "<key name>"],
  ];
  let result = message;
  for (const [secret, label] of replacements) {
    if (secret !== "") {
      result = result.replaceAll(secret, label);
    }
  }
  return result;
}

/**
 * Runs `step` and fails with any error's name and message, the vault, key name and version
 * removed. The plugin's errors name the key id. The original error is not passed on, since
 * node:test would print it.
 */
async function redacted<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    const name = error instanceof Error ? error.name : typeof error;
    const message = error instanceof Error ? error.message : String(error);
    return assert.fail(redact(`${name}: ${message}`));
  }
}

async function publicKeyOf(adapter: KmsKeyAdapter): Promise<Uint8Array> {
  const publicKey = await adapter.getPublicKey?.(signContext());
  assert.ok(publicKey?.length === 65, "the adapter returned no 65-byte public key");
  return publicKey;
}

/** Signs a random digest and checks the signature against the key's public key. */
async function signAndCheck(adapter: KmsKeyAdapter, publicKey: Uint8Array): Promise<boolean> {
  const digest = secp256k1.utils.randomSecretKey();
  return checkSignature(publicKey, digest, await signDigest(adapter, digest)).highS;
}

describe("Azure adapter on real Azure Key Vault", { skip: keyId === "", timeout: 300_000 }, () => {
  it("names a versioned key URL", () => {
    assert.ok(
      match !== null,
      "HARDHAT_KMS_LIVE_AZURE_KEY_ID must be https://<vault>/keys/<name>/<version>",
    );
  });

  it("signs digests with the versioned key id that verify and recover to the key", async () => {
    await redacted(async () => {
      await withAdapter({ provider: "azure", keyId }, async (adapter) => {
        const publicKey = await publicKeyOf(adapter);
        const highS: boolean[] = [];
        for (let index = 0; index < 16; index++) {
          highS.push(await signAndCheck(adapter, publicKey));
        }
        // Key Vault does not normalize S: about half its signatures are high-S, which the core
        // folds. Report it, without failing on an unlucky run.
        process.stdout.write(`# ${highS.filter(Boolean).length} of 16 signatures were high-S\n`);
      });
    });
  });

  it("pins the same key from the unversioned id and from the components", async () => {
    await redacted(async () => {
      const keys: Uint8Array[] = [];
      const forms: AzureKmsKeyUserConfig[] = [
        { provider: "azure", keyId },
        { provider: "azure", keyId: `${vaultUrl}/keys/${keyName}` },
        { provider: "azure", vaultUrl, keyName, keyVersion },
      ];
      for (const key of forms) {
        await withAdapter(key, async (adapter) => {
          const publicKey = await publicKeyOf(adapter);
          keys.push(publicKey);
          await signAndCheck(adapter, publicKey);
        });
      }
      const [first, ...rest] = keys.map((key) => Buffer.from(key).toString("hex"));
      for (const other of rest) {
        assert.equal(
          other,
          first,
          "another form of the key id gave another public key; is the version the current one?",
        );
      }
    });
  });

  it("refuses a version that does not exist, with Key Vault's 404", async () => {
    let message = "none";
    try {
      await withAdapter(
        { provider: "azure", keyId: `${vaultUrl}/keys/${keyName}/${"0".repeat(32)}` },
        async (adapter) => {
          await publicKeyOf(adapter);
        },
      );
    } catch (error) {
      message = redact(error instanceof Error ? error.message : String(error));
    }
    assert.match(message, /Key Vault answered 404/);
  });
});
