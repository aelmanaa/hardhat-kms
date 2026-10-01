import type { KmsKeyCommonConfig, KmsKeyConfig } from "../../types.ts";

/**
 * The settings of every key that the signer and its adapter use: the key's name and display form
 * for errors, the address pin and both time budgets.
 */
function commonSettings(key: KmsKeyCommonConfig): unknown[] {
  return [
    key.name,
    key.displayId,
    key.address ?? null,
    key.timeoutMs,
    key.approvalTimeoutMs ?? null,
  ];
}

/**
 * What decides the signer a key of a first-party provider gets: the provider, the identifier read
 * the way the adapter reads it, every setting the adapter connects with, and the settings the
 * signer takes. Two key objects with the same identity can share one signer, such as the copies
 * Hardhat makes of a key for each connection with config overrides.
 *
 * Unlike `keyIdentity`, an AWS key always includes its region, profile and endpoint, even for an
 * ARN: the profile selects the credentials, and the endpoint where requests go. The key's name is
 * part of the identity too, so two names for one key get two signers and errors name the right
 * key. The result contains identifier values: it is for comparing keys, never for printing.
 *
 * @param key - The resolved key.
 * @returns The identity, or `undefined` for a key of a third-party provider.
 * @throws What the identifier's `get()` throws, such as an unset configuration variable.
 */
export async function signerIdentity(key: KmsKeyConfig): Promise<string | undefined> {
  if ("keyVersionName" in key) {
    // Google Cloud credentials and the API endpoint come from the environment, not the key.
    return JSON.stringify(["gcp", await key.keyVersionName.get(), ...commonSettings(key)]);
  }
  if (key.provider === "azure") {
    // The key URL names the vault; credentials come from the environment, not the key.
    return JSON.stringify(["azure", await key.keyId.get(), ...commonSettings(key)]);
  }
  if (key.provider === "aws") {
    return JSON.stringify([
      "aws",
      await key.keyId.get(),
      key.region ?? null,
      key.profile ?? null,
      key.endpoint ?? null,
      ...commonSettings(key),
    ]);
  }
  return undefined;
}
