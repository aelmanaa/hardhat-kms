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
 * What decides the signer a key of a first-party provider gets: the provider, how the config gives
 * the identifier, every setting the adapter connects with, and the settings the signer takes. Two
 * key objects with the same identity share one signer, such as the copies Hardhat makes of a key
 * for each connection with config overrides.
 *
 * The identifier counts by its display form: the literal value, or `<NAME>` for a configuration
 * variable. Literal identifiers are checked against their provider's format when the config loads,
 * and no format allows `<` or `>`, so a literal never looks like a variable. The identity is
 * therefore computed without reading a configuration variable: it cannot fail or prompt for a
 * keystore password, and the adapter stays the first to read the value, after the provider
 * plugin's checks. Within a runtime, the signer reads a variable once, when it is created, as it
 * does for the connections without overrides. Two variables that hold the same value get two
 * signers.
 *
 * Unlike `keyIdentity`, an AWS key always includes its region, profile and endpoint, even for an
 * ARN: the profile selects the credentials, and the endpoint where requests go. The key's name is
 * part of the identity too, so two names for one key get two signers and errors name the right
 * key. Google Cloud and Azure keys have no other connection settings: credentials and endpoints
 * come from the environment, and an Azure key URL names its vault. The identity is for comparing
 * keys, never for printing.
 *
 * @param key - The resolved key.
 * @returns The identity, or `undefined` for a key of a third-party provider.
 */
export function signerIdentity(key: KmsKeyConfig): string | undefined {
  if ("keyVersionName" in key) {
    return JSON.stringify(["gcp", key.keyVersionName.display, ...commonSettings(key)]);
  }
  if (key.provider === "azure") {
    return JSON.stringify(["azure", key.keyId.display, ...commonSettings(key)]);
  }
  if (key.provider === "aws") {
    return JSON.stringify([
      "aws",
      key.keyId.display,
      key.region ?? null,
      key.profile ?? null,
      key.endpoint ?? null,
      ...commonSettings(key),
    ]);
  }
  return undefined;
}
