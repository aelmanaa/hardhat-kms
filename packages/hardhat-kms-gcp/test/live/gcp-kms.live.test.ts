// Runs the Google Cloud adapter against real Cloud KMS: `pnpm run test:live:gcp`. It is skipped
// unless HARDHAT_KMS_LIVE_GCP_KEY holds the full name of an EC_SIGN_SECP256K1_SHA256 key version
// (projects/…/cryptoKeyVersions/<n>), and it uses the developer's Application Default Credentials
// (`gcloud auth application-default login`). It creates nothing. The project, key ring and key
// names are redacted from every failure it reports.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { GcpKmsKeyUserConfig, KmsKeyAdapter, KmsKeyConfig } from "hardhat-kms/types";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsGcp from "../../src/index.ts";

const keyVersionName = process.env.HARDHAT_KMS_LIVE_GCP_KEY?.trim() ?? "";
const parts =
  /^projects\/([^/]+)\/locations\/([^/]+)\/keyRings\/([^/]+)\/cryptoKeys\/([^/]+)\/cryptoKeyVersions\/(\d+)$/.exec(
    keyVersionName,
  );
const CURVE_ORDER = secp256k1.Point.CURVE().n;

/** Removes the project, key ring and key names from a message. */
function redact(message: string): string {
  let text = message.replaceAll(keyVersionName, "<key version>");
  for (const part of (parts ?? []).slice(1, 5)) {
    text = text.replaceAll(part, "<redacted>");
  }
  return text;
}

/**
 * Runs `step` and rethrows any failure with the names removed. The original error is not kept as
 * `cause`, since node:test would print it.
 */
async function redacted<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    const name = error instanceof Error ? error.name : typeof error;
    const message = error instanceof Error ? error.message : String(error);
    // oxlint-disable-next-line eslint/preserve-caught-error -- the cause would be printed unredacted
    throw new Error(redact(`${name}: ${message}`));
  }
}

const signContext = () => ({
  signal: new AbortController().signal,
  displayMessage: async () => {},
  requestId: "live",
});

/** Builds the adapter through the plugin and the `kms` hook chain, runs `use`, and closes it. */
async function withAdapter(
  key: GcpKmsKeyUserConfig,
  use: (adapter: KmsKeyAdapter) => Promise<void>,
): Promise<void> {
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKmsGcp],
    kms: { keys: { deployer: key } },
  });
  const resolved = hre.config.kms.keys.deployer;
  assert.ok(resolved);
  const adapter = await hre.hooks.runHandlerChain(
    "kms",
    "createKeyAdapter",
    [resolved],
    async (_context, rest: KmsKeyConfig) =>
      await Promise.reject(new Error(`unclaimed ${rest.displayId}`)),
  );
  try {
    await use(adapter);
  } finally {
    await adapter.close?.();
  }
}

async function publicKeyOf(adapter: KmsKeyAdapter): Promise<Uint8Array> {
  const publicKey = await adapter.getPublicKey?.(signContext());
  assert.ok(publicKey?.length === 65, "the adapter returned no 65-byte public key");
  return publicKey;
}

/**
 * Signs a random digest and checks the signature the way the plugin does: fold a high S, verify,
 * and recover the public key with one of the two recovery ids.
 *
 * @returns Whether KMS returned a high S.
 */
async function signAndCheck(adapter: KmsKeyAdapter, publicKey: Uint8Array): Promise<boolean> {
  const digest = secp256k1.utils.randomSecretKey();
  const output = await adapter.signDigest?.({ digest }, signContext());
  assert.ok(output !== undefined && "format" in output && output.format === "der");
  const signature = secp256k1.Signature.fromBytes(output.bytes, "der");
  const highS = signature.s > CURVE_ORDER / 2n;
  const low = highS ? new secp256k1.Signature(signature.r, CURVE_ORDER - signature.s) : signature;
  assert.ok(
    secp256k1.verify(low.toBytes("compact"), digest, publicKey, { prehash: false }),
    "the signature does not verify against the key's public key",
  );
  const recovered = [0, 1].map((bit) =>
    low.addRecoveryBit(bit).recoverPublicKey(digest).toBytes(false),
  );
  assert.ok(
    recovered.some((candidate) => Buffer.from(candidate).equals(Buffer.from(publicKey))),
    "no recovery id recovers the key's public key",
  );
  return highS;
}

describe(
  "Google Cloud adapter on real Cloud KMS",
  { skip: keyVersionName === "", timeout: 300_000 },
  () => {
    it("is given a full key version name", () => {
      assert.ok(
        parts !== null,
        "HARDHAT_KMS_LIVE_GCP_KEY must be projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>/cryptoKeyVersions/<n>",
      );
    });

    it("signs digests that verify and recover to the key, with every CRC32C check", async () => {
      await redacted(async () => {
        await withAdapter({ provider: "gcp", keyVersionName }, async (adapter) => {
          const publicKey = await publicKeyOf(adapter);
          for (let index = 0; index < 16; index++) {
            await signAndCheck(adapter, publicKey);
          }
        });
      });
    });

    it("gets the same key from the components form", async () => {
      assert.ok(parts !== null);
      const [, projectId = "", location = "", keyRing = "", keyName = "", keyVersion = ""] = parts;
      await redacted(async () => {
        const keys: Uint8Array[] = [];
        await withAdapter({ provider: "gcp", keyVersionName }, async (adapter) => {
          keys.push(await publicKeyOf(adapter));
        });
        await withAdapter(
          { provider: "gcp", projectId, location, keyRing, keyName, keyVersion },
          async (adapter) => {
            const publicKey = await publicKeyOf(adapter);
            keys.push(publicKey);
            await signAndCheck(adapter, publicKey);
          },
        );
        assert.ok(
          Buffer.from(keys[0] ?? []).equals(Buffer.from(keys[1] ?? [])),
          "the components form resolves to another public key",
        );
      });
    });

    it("explains a key version that does not exist", async () => {
      assert.ok(parts !== null);
      const missing = keyVersionName.replace(/\d+$/, "999999");
      let message = "none";
      try {
        await withAdapter({ provider: "gcp", keyVersionName: missing }, async (adapter) => {
          await publicKeyOf(adapter);
        });
      } catch (error) {
        message = redact(error instanceof Error ? error.message : String(error));
      }
      // Cloud KMS answers NOT_FOUND, or PERMISSION_DENIED when the caller's role is granted on
      // the key version rather than on the key.
      assert.match(message, /\((NOT_FOUND|PERMISSION_DENIED)\)/);
    });
  },
);
