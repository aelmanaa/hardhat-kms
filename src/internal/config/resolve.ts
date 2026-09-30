import type { HardhatUserConfig } from "hardhat/config";
import type { ConfigurationVariableResolver, HardhatConfig } from "hardhat/types/config";

import type {
  ExternalKmsKeyConfig,
  KmsConfig,
  KmsKeyConfig,
  KmsKeyUserConfig,
} from "../../types.ts";
import { BUILTIN_PROVIDER_CONFIGS } from "../providers/builtin-config.ts";
import { DEFAULT_TIMEOUT_MS } from "./common.ts";
import { type KeyResolveContext, resolveCommonKeyConfig } from "./key-common.ts";

function resolveExternalKey(
  key: KmsKeyUserConfig,
  context: KeyResolveContext,
): ExternalKmsKeyConfig {
  const { provider } = key as { provider: string };
  return {
    provider,
    ...resolveCommonKeyConfig(key, context, `${provider}:${context.name}`),
    userConfig: Object.freeze({ ...key }),
  };
}

function resolveKey(key: KmsKeyUserConfig, context: KeyResolveContext): KmsKeyConfig {
  const builtin = BUILTIN_PROVIDER_CONFIGS[key.provider];
  return builtin === undefined ? resolveExternalKey(key, context) : builtin.resolve(key, context);
}

/**
 * Resolves the `kms` section. Expects a config that passed validation.
 *
 * @param userConfig - The validated user config.
 * @param resolveVariable - Hardhat's configuration variable resolver.
 * @returns The resolved `kms` section.
 */
export function resolveKmsConfig(
  userConfig: HardhatUserConfig,
  resolveVariable: ConfigurationVariableResolver,
): KmsConfig {
  const user = userConfig.kms ?? {};
  const approvalTimeoutMs = user.defaults?.approvalTimeoutMs;
  const region = user.defaults?.aws?.region;
  const defaults: KmsConfig["defaults"] = {
    aws: region === undefined ? {} : { region },
    timeoutMs: user.defaults?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs }),
  };
  const keys = Object.fromEntries(
    Object.entries(user.keys ?? {}).map(([name, key]) => [
      name,
      resolveKey(key, { name, resolveVariable, defaults }),
    ]),
  );
  return {
    keys,
    defaults,
    allowCrossChainTypedData: user.allowCrossChainTypedData ?? false,
    ...(user.simulatedBalance === undefined ? {} : { simulatedBalance: user.simulatedBalance }),
  };
}

/**
 * Adds the resolved `kms` section and each network's `kmsAccounts` to a resolved config.
 *
 * @param userConfig - The validated user config.
 * @param resolvedConfig - The config resolved so far by Hardhat and other plugins.
 * @param resolveVariable - Hardhat's configuration variable resolver.
 * @returns The resolved config with this plugin's parts.
 */
export function resolveKmsUserConfig(
  userConfig: HardhatUserConfig,
  resolvedConfig: HardhatConfig,
  resolveVariable: ConfigurationVariableResolver,
): HardhatConfig {
  const kms = resolveKmsConfig(userConfig, resolveVariable);
  const networks = Object.fromEntries(
    Object.entries(resolvedConfig.networks).map(([network, networkConfig]) => {
      const accounts = userConfig.networks?.[network]?.kmsAccounts ?? [];
      const kmsAccounts = accounts.map((account, index) => {
        if (typeof account === "string") {
          const key = kms.keys[account];
          if (key === undefined) {
            // Validation rejects unknown names; this guards against resolving an unvalidated config.
            throw new Error(`Unknown key "${account}" in networks.${network}.kmsAccounts`);
          }
          return key;
        }
        return resolveKey(account, {
          name: `${network}.kmsAccounts[${index}]`,
          resolveVariable,
          defaults: kms.defaults,
        });
      });
      return [network, { ...networkConfig, kmsAccounts }];
    }),
  );
  return { ...resolvedConfig, kms, networks };
}
