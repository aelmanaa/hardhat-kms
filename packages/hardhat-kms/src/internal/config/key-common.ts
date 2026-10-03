import type { ConfigurationVariableResolver } from "hardhat/types/config";

import type { KmsConfig, KmsKeyCommonConfig, KmsKeyCommonUserConfig } from "../../types.ts";
import { toChecksumAddress } from "../crypto/address.ts";

/** What a provider needs to resolve one key. */
export interface KeyResolveContext {
  /** The key's name, or `<network>.kmsAccounts[<index>]` for an inline key. */
  name: string;
  /** The key's config path, such as `kms.keys.deployer`, for error messages. */
  path: string;
  resolveVariable: ConfigurationVariableResolver;
  defaults: KmsConfig["defaults"];
}

/**
 * Resolves the settings every key shares.
 *
 * @param key - The validated user config of the key.
 * @param context - The key's name and the resolved defaults.
 * @param displayId - The provider's printable description of the key.
 * @returns The common resolved settings.
 */
export function resolveCommonKeyConfig(
  key: KmsKeyCommonUserConfig,
  context: KeyResolveContext,
  displayId: string,
): KmsKeyCommonConfig {
  return {
    name: context.name,
    displayId,
    timeoutMs: key.timeoutMs ?? context.defaults.timeoutMs,
    ...(key.address === undefined ? {} : { address: toChecksumAddress(key.address) }),
  };
}
