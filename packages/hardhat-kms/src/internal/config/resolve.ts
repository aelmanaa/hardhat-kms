import type { HardhatUserConfig } from "hardhat/config";
import type { ConfigurationVariableResolver, HardhatConfig } from "hardhat/types/config";

import type {
  ExternalKmsKeyConfig,
  KmsConfig,
  KmsKeyConfig,
  KmsKeyUserConfig,
} from "../../types.ts";
import { builtinProvider } from "../providers/registry.ts";
import { DEFAULT_TIMEOUT_MS } from "./common.ts";
import { isConfigurationVariable } from "./identifiers.ts";
import { type KeyResolveContext, resolveCommonKeyConfig } from "./key-common.ts";

/** Replaces configuration variables with resolved ones, recursively, and freezes the result. */
function resolveVariablesDeep(
  value: unknown,
  resolveVariable: ConfigurationVariableResolver,
): unknown {
  if (isConfigurationVariable(value)) {
    return resolveVariable(value);
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item: unknown) => resolveVariablesDeep(item, resolveVariable)));
  }
  if (typeof value === "object" && value !== null) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([field, item]) => [
          field,
          resolveVariablesDeep(item, resolveVariable),
        ]),
      ),
    );
  }
  return value;
}

function resolveExternalKey(
  key: KmsKeyUserConfig,
  context: KeyResolveContext,
): ExternalKmsKeyConfig {
  const provider: string = key.provider;
  const userConfig = Object.freeze(
    Object.fromEntries(
      Object.entries(key).map(([field, value]) => [
        field,
        resolveVariablesDeep(value, context.resolveVariable),
      ]),
    ),
  );
  return {
    provider,
    ...resolveCommonKeyConfig(key, context, `${provider}:${context.name}`),
    userConfig,
  };
}

/**
 * Resolves one validated key, whatever its provider.
 *
 * @param key - The key's user config.
 * @param context - The key's name, config path, variable resolver and defaults.
 * @returns The resolved key.
 */
export function resolveKey(key: KmsKeyUserConfig, context: KeyResolveContext): KmsKeyConfig {
  const builtin = builtinProvider(key.provider);
  if (builtin !== undefined) {
    return builtin.resolve(key, context);
  }
  // KmsKeyConfig is an open union: third-party providers add their member by augmenting
  // KmsProviderConfigs, which TypeScript cannot see from here. Adding ExternalKmsKeyConfig to the
  // union instead would stop users from narrowing on `provider`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- open union, allowed in scripts/type-escapes.json
  return resolveExternalKey(key, context) as unknown as KmsKeyConfig;
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
      resolveKey(key, { name, path: `kms.keys.${name}`, resolveVariable, defaults }),
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
          const key = Object.hasOwn(kms.keys, account) ? kms.keys[account] : undefined;
          if (key === undefined) {
            // Validation rejects unknown names; this guards against resolving an unvalidated config.
            throw new Error(`Unknown key "${account}" in networks.${network}.kmsAccounts`);
          }
          return key;
        }
        return resolveKey(account, {
          name: `${network}.kmsAccounts[${index}]`,
          path: `networks.${network}.kmsAccounts.${index}`,
          resolveVariable,
          defaults: kms.defaults,
        });
      });
      return [network, { ...networkConfig, kmsAccounts }];
    }),
  );
  return { ...resolvedConfig, kms, networks };
}
