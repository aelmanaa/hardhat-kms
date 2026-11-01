import type { KmsIdentifier, KmsKeyCommonConfig, KmsKeyConfig } from "../../types.ts";
import { identifierComparisonForm } from "../config/identifiers.ts";

/**
 * The settings of every key that the signer and its adapter use: the key's name and display form
 * for errors, the address pin and the time budget.
 */
function commonSettings(key: KmsKeyCommonConfig): unknown[] {
  return [key.name, key.displayId, key.address ?? null, key.timeoutMs];
}

/**
 * An optional setting's comparison form: `null` when it is not set, `undefined` when config
 * resolution did not build it.
 */
function settingForm(setting: KmsIdentifier | undefined): string | null | undefined {
  return setting === undefined ? null : identifierComparisonForm(setting);
}

/**
 * What decides the signer a key of a first-party provider gets: the provider, the identifier as
 * written in the config, every setting the adapter connects with, and the settings the signer
 * takes. Two key objects with the same identity share one signer, such as the copies Hardhat makes
 * of a key for each connection with config overrides.
 *
 * The identifier, and an AWS key's region and profile, count by their comparison forms
 * (`identifierComparisonForm`): a literal's value, or a configuration variable's name, `format`
 * and `default`. The identity is built without reading any configuration variable, so computing
 * it cannot fail or prompt for a keystore password, and the adapter stays the first to read the
 * value, after the provider plugin's checks. Within a runtime, the signer reads a variable once,
 * when it is created, as it does for the connections without overrides. Two variables that hold
 * the same value get two signers.
 *
 * Unlike `keyIdentity`, an AWS key always includes its region, profile and endpoint, even for an
 * ARN: the profile selects the credentials, and the endpoint where requests go. The key's name is
 * part of the identity too, so two names for one key get two signers and errors name the right
 * key. Google Cloud and Azure keys have no other connection settings: credentials and endpoints
 * come from the environment, and an Azure key URL names its vault. A Turnkey key's identifier is
 * its organization id, and its API private and public keys count as settings, by their
 * comparison forms: the variable's name, never its value, and so does its `transactionSigning`.
 *
 * Never print or log the identity: a variable's `default` can be a secret.
 *
 * @param key - The resolved key.
 * @returns The identity, or `undefined` for a key of a third-party provider or an identifier,
 * region or profile that config resolution did not build.
 */
export function signerIdentity(key: KmsKeyConfig): string | undefined {
  let parts: unknown[];
  let identifier: KmsIdentifier;
  // The identity is only compared for equality. An AWS or Turnkey identity has 9 parts, a Google
  // Cloud or Azure one 6, so the provider tags have to tell AWS from Turnkey and Google Cloud from
  // Azure. Each pair has two tags, so changing any one tag still leaves the pair apart, and
  // dropping one changes the length. This rests on the lengths: a new provider whose identity also
  // has 6 or 9 parts needs a test that tells its tag apart.
  if ("keyVersionName" in key) {
    // Stryker disable next-line ArrayDeclaration,StringLiteral: one tag alone is redundant
    parts = ["gcp"];
    identifier = key.keyVersionName;
  } else if (key.provider === "azure") {
    // Stryker disable next-line ArrayDeclaration,StringLiteral: one tag alone is redundant
    parts = ["azure"];
    identifier = key.keyId;
  } else if (key.provider === "turnkey") {
    // The API keys select the credentials, and `transactionSigning` decides whether the adapter
    // has `signTransaction`, so two keys that differ only in them get two signers. A key always
    // has an API private key; config resolution builds both forms without reading either
    // variable.
    const privateKey = identifierComparisonForm(key.apiPrivateKey);
    const publicKey = settingForm(key.apiPublicKey);
    if (privateKey === undefined || publicKey === undefined) {
      return undefined;
    }
    // Stryker disable next-line StringLiteral: one tag alone is redundant
    parts = ["turnkey", privateKey, publicKey, key.transactionSigning];
    identifier = key.organizationId;
  } else if (
    // A resolved third-party key keeps its own fields under `userConfig`, so it has no `keyId`:
    // the AWS branch would return `undefined` for it too, from identifierComparisonForm.
    // Stryker disable next-line ConditionalExpression: a third-party key gets undefined either way
    key.provider === "aws"
  ) {
    const region = settingForm(key.region);
    const profile = settingForm(key.profile);
    if (region === undefined || profile === undefined) {
      return undefined;
    }
    // Stryker disable next-line StringLiteral: one tag alone is redundant
    parts = ["aws", region, profile, key.endpoint ?? null];
    identifier = key.keyId;
  } else /* Stryker disable next-line BlockStatement: undefined either way, see above */ {
    return undefined;
  }
  const form = identifierComparisonForm(identifier);
  return form === undefined ? undefined : JSON.stringify([...parts, form, ...commonSettings(key)]);
}
