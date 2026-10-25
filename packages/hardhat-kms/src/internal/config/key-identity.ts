import type { KmsKeyConfig } from "../../types.ts";
import { parseAwsKeyId } from "../providers/aws/key-id.ts";
import { parseAzureKeyId } from "../providers/azure/key-id.ts";

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

/**
 * What the list-bypass check compares: the key's identifier, with what it says written one way,
 * and, for an Azure key, its version when it names one.
 */
export interface ListBypassIdentity {
  /** The provider and the identifier, without an Azure key's version. */
  key: string;
  /** An Azure key's version, in lowercase, or `undefined` for the latest one or another provider. */
  version?: string;
}

/**
 * The identity a `--kms` key and a config key with `allowedDelegates` are compared by, before a
 * task signs an authorization with the `--kms` key (#562, #589). Unlike {@link keyIdentity}, it
 * leans towards a match: a false match only asks the user to name the config key, while a missed
 * one signs without that key's list.
 *
 * - An AWS key counts by its key id or alias name alone, in lowercase, without the region,
 *   profile or endpoint, and taken out of an ARN. The SDK may find the region in the environment,
 *   so the config cannot tell where a key id or alias is looked up. A key ARN and an alias still
 *   differ: only the KMS knows which key an alias points to.
 * - An Azure key counts by its vault and key name in lowercase, with or without a trailing slash.
 *   A key without a version, which signs with the latest one, matches every version of that key.
 * - A Google Cloud key version name counts as written. Google Cloud can take a project number in
 *   place of the project id, and the two are not matched: only Google knows which id a number
 *   belongs to. An `address` pin catches that.
 *
 * Contains identifier values, so never print it.
 *
 * @param key - The resolved key.
 * @returns The identity, or `undefined` for a key of a third-party provider.
 */
export async function listBypassIdentity(
  key: KmsKeyConfig,
): Promise<ListBypassIdentity | undefined> {
  if (key.provider === "aws") {
    const id = await key.keyId.get();
    // An ARN ends in `key/<key id>` or in the alias name, after its last colon. A key id or an
    // alias name has no colon.
    const resource = id.slice(id.lastIndexOf(":") + 1).replace(/^key\//, "");
    return { key: `aws\0${resource.toLowerCase()}` };
  }
  if (key.provider === "azure") {
    const id = await key.keyId.get();
    const parsed = parseAzureKeyId(id);
    if (parsed === undefined) {
      return { key: `azure\0${id}` };
    }
    const identity = { key: `azure\0${parsed.vaultUrl}/keys/${parsed.keyName}`.toLowerCase() };
    return parsed.keyVersion === undefined
      ? identity
      : { ...identity, version: parsed.keyVersion.toLowerCase() };
  }
  const identity = await keyIdentity(key);
  return identity === undefined ? undefined : { key: identity };
}

/**
 * Whether two keys are the same KMS key for the list-bypass check.
 *
 * @param a - One key's {@link listBypassIdentity}.
 * @param b - The other's.
 * @returns Whether their identifiers match and, when both name an Azure key version, the versions.
 */
export function sameListBypassIdentity(
  a: ListBypassIdentity | undefined,
  b: ListBypassIdentity | undefined,
): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.key === b.key &&
    (a.version === undefined || b.version === undefined || a.version === b.version)
  );
}
