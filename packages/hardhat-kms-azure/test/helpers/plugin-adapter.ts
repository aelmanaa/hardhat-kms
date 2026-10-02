import assert from "node:assert/strict";

import type { TokenCredential } from "@azure/identity";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type {
  AzureKmsKeyUserConfig,
  KmsKeyAdapter,
  KmsKeyConfig,
  SignContext,
} from "hardhat-kms/types";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsAzure from "../../src/index.ts";
import {
  type AzureClientOptions,
  type AzureKeyVaultSdk,
  createAzureKeyAdapter,
  type KeyVaultKeyLike,
} from "../../src/internal/adapter.ts";
import type { AzureAdapterFactoryLoader } from "../../src/internal/hook-handlers/kms.ts";

const CURVE_ORDER = secp256k1.Point.CURVE().n;

/** A signing context with a fresh, never-aborted signal. */
export const signContext = (): SignContext => ({
  signal: new AbortController().signal,
  displayMessage: async () => {},
  requestId: "r1",
});

/**
 * A loader for `kmsHandlers` that builds adapters on the given SDK and credential, in place of
 * the real credential chain.
 *
 * @param sdk - The SDK module, real or fake.
 * @param credential - The credential.
 * @param options - Client options, such as a fake HttpClient for the real SDK.
 * @returns The loader.
 */
export function loaderFor<Key extends KeyVaultKeyLike>(
  sdk: AzureKeyVaultSdk<Key>,
  credential: TokenCredential,
  options: AzureClientOptions = {},
): AzureAdapterFactoryLoader {
  return async (userAgent) =>
    await Promise.resolve(
      async (key) => await createAzureKeyAdapter(key, sdk, credential, userAgent, options),
    );
}

/**
 * Builds the adapter for an Azure key the way a Hardhat project with hardhat-kms-azure does (the
 * plugin and the `kms` hook chain), runs `use` with it and closes it.
 *
 * @param key - The key's config, as in `kms.keys`.
 * @param use - What to do with the adapter.
 */
export async function withAdapter(
  key: AzureKmsKeyUserConfig,
  use: (adapter: KmsKeyAdapter) => Promise<void>,
): Promise<void> {
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKmsAzure],
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

/**
 * Checks an `r || s` signature from Key Vault the way the plugin does: fold a high S, verify, and
 * recover the public key with one of the two recovery ids.
 *
 * @param publicKey - The key's 65-byte uncompressed public key.
 * @param digest - The signed digest.
 * @param compact - The signature, as Key Vault returned it.
 * @returns Whether Key Vault returned a high S.
 */
export function checkSignature(
  publicKey: Uint8Array,
  digest: Uint8Array,
  compact: Uint8Array,
): { highS: boolean } {
  assert.equal(compact.length, 64, "Key Vault did not return 64 bytes r || s");
  const signature = secp256k1.Signature.fromBytes(compact, "compact");
  const highS = signature.hasHighS();
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
  return { highS };
}

/** Signs a digest and returns the `r || s` signature, which Key Vault always returns. */
export async function signDigest(adapter: KmsKeyAdapter, digest: Uint8Array): Promise<Uint8Array> {
  const signature = await adapter.signDigest?.({ digest }, signContext());
  assert.ok(signature !== undefined && "format" in signature && signature.format === "compact");
  return signature.bytes;
}
