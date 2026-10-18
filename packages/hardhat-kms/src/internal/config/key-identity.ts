import type { KmsKeyConfig } from "../../types.ts";
import { parseAwsKeyId } from "../providers/aws/key-id.ts";

/**
 * What makes two keys of a first-party provider the same KMS key: the identifier, read the way
 * the adapter reads it, plus, for an AWS key id or alias, the settings that decide where it is
 * looked up. The result contains identifier values, so it is for comparing keys, never for
 * printing.
 *
 * @param key - The resolved key.
 * @returns The identity, or `undefined` for a key of a third-party provider.
 */
export async function keyIdentity(key: KmsKeyConfig): Promise<string | undefined> {
  if ("keyVersionName" in key) {
    return `gcp\0${await key.keyVersionName.get()}`;
  }
  if (key.provider === "azure") {
    return `azure\0${await key.keyId.get()}`;
  }
  if (key.provider === "turnkey") {
    // An organization id is a UUID, in any case. The address is already checksummed. The API key
    // only decides who asks, so two API keys for one account name one key.
    return `turnkey\0${(await key.organizationId.get()).toLowerCase()}\0${key.address}`;
  }
  if (key.provider === "aws") {
    const id = await key.keyId.get();
    // An ARN names its account and region. A key id or alias names a key only together with the
    // region, profile and endpoint it is looked up in.
    // The region and profile count by value, so a variable and a literal that hold the same
    // profile name one key.
    if (parseAwsKeyId(id)?.kind === "keyArn" || parseAwsKeyId(id)?.kind === "aliasArn") {
      return `aws\0${id}`;
    }
    const region = (await key.region?.get()) ?? "";
    const profile = (await key.profile?.get()) ?? "";
    return `aws\0${id}\0${region}\0${profile}\0${key.endpoint ?? ""}`;
  }
  return undefined;
}
