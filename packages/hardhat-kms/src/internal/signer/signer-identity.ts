import type { KmsIdentifier, KmsKeyCommonConfig, KmsKeyConfig } from "../../types.ts";
import { identifierComparisonForm } from "../config/identifiers.ts";

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
 * What decides the signer a key of a first-party provider gets: the provider, the identifier as
 * written in the config, every setting the adapter connects with, and the settings the signer
 * takes. Two key objects with the same identity share one signer, such as the copies Hardhat makes
 * of a key for each connection with config overrides.
 *
 * The identifier counts by its comparison form (`identifierComparisonForm`): a literal's value, or
 * a configuration variable's name, `format` and `default`. It is built without reading any
 * configuration variable, so computing the identity cannot fail or prompt for a keystore password,
 * and the adapter stays the first to read the value, after the provider plugin's checks. Within a
 * runtime, the signer reads a variable once, when it is created, as it does for the connections
 * without overrides. Two variables that hold the same value get two signers.
 *
 * Unlike `keyIdentity`, an AWS key always includes its region, profile and endpoint, even for an
 * ARN: the profile selects the credentials, and the endpoint where requests go. The key's name is
 * part of the identity too, so two names for one key get two signers and errors name the right
 * key. Google Cloud and Azure keys have no other connection settings: credentials and endpoints
 * come from the environment, and an Azure key URL names its vault.
 *
 * Never print or log the identity: a variable's `default` can be a secret.
 *
 * @param key - The resolved key.
 * @returns The identity, or `undefined` for a key of a third-party provider or an identifier that
 * config resolution did not build.
 */
export function signerIdentity(key: KmsKeyConfig): string | undefined {
  let parts: unknown[];
  let identifier: KmsIdentifier;
  if ("keyVersionName" in key) {
    parts = ["gcp"];
    identifier = key.keyVersionName;
  } else if (key.provider === "azure") {
    parts = ["azure"];
    identifier = key.keyId;
  } else if (key.provider === "aws") {
    parts = ["aws", key.region ?? null, key.profile ?? null, key.endpoint ?? null];
    identifier = key.keyId;
  } else {
    return undefined;
  }
  const form = identifierComparisonForm(identifier);
  return form === undefined ? undefined : JSON.stringify([...parts, form, ...commonSettings(key)]);
}
