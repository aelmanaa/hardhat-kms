import type { ConfigurationVariableResolver } from "hardhat/types/config";

import type {
  KmsAllowedDelegate,
  KmsAllowedDelegateUserConfig,
  KmsConfig,
  KmsKeyCommonConfig,
  KmsKeyCommonUserConfig,
} from "../../types.ts";
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
    ...(key.allowRawDigests === true ? { allowRawDigests: true } : {}),
    ...(key.allowedDelegates === undefined
      ? {}
      : { allowedDelegates: Object.freeze(key.allowedDelegates.map(resolveAllowedDelegate)) }),
  };
}

/**
 * Resolves one validated `allowedDelegates` entry: a checksummed address, a lowercase code hash,
 * and a frozen copy, so later changes to the user's object do not reach it.
 */
function resolveAllowedDelegate(entry: KmsAllowedDelegateUserConfig): KmsAllowedDelegate {
  return Object.freeze({
    address: toChecksumAddress(entry.address),
    chains: entry.chains === "all" ? "all" : Object.freeze([...entry.chains]),
    ...(entry.label === undefined ? {} : { label: entry.label }),
    ...(entry.codeHash === undefined ? {} : { codeHash: entry.codeHash.toLowerCase() }),
  });
}
