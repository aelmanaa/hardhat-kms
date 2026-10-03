import { parseAwsKeyId } from "hardhat-kms/provider-utils";
import type { AwsKmsKeyConfig, KmsIdentifier } from "hardhat-kms/types";

/** The region and profile an AWS SDK client is built with, each left out when unset. */
export interface AwsClientSettings {
  region?: string;
  profile?: string;
}

/** A setting's value; `undefined` when the setting is absent or empty. */
async function settingValue(setting: KmsIdentifier | undefined): Promise<string | undefined> {
  const value = setting === undefined ? "" : await setting.get();
  return value === "" ? undefined : value;
}

/**
 * Reads the region and profile of a key's AWS SDK clients. A key ARN names its region, which wins
 * over the configured one; the `keyId` check has already compared the two, so the configured
 * region is not read then. Values from configuration variables are read here, when the key is
 * first used, and an empty value leaves the setting to the AWS SDK.
 *
 * @param key - The resolved key.
 * @param keyId - The key's identifier, already read.
 * @returns The settings.
 */
export async function awsClientSettings(
  key: AwsKmsKeyConfig,
  keyId: string,
): Promise<AwsClientSettings> {
  const region = parseAwsKeyId(keyId)?.region ?? (await settingValue(key.region));
  const profile = await settingValue(key.profile);
  return {
    ...(region === undefined ? {} : { region }),
    ...(profile === undefined ? {} : { profile }),
  };
}
