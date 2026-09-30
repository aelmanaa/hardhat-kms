import type { ConfigHooks } from "hardhat/types/hooks";

import { resolveKmsUserConfig } from "../config/resolve.ts";
import { validateKmsUserConfig } from "../config/validate.ts";
import { kmsDebug } from "../debug.ts";

const log = kmsDebug("config");

/**
 * Config hook handlers: validate the `kms` section and `kmsAccounts`, then resolve them.
 *
 * @returns The handlers.
 */
export default async (): Promise<Partial<ConfigHooks>> => ({
  validateUserConfig: async (userConfig) => validateKmsUserConfig(userConfig),
  resolveUserConfig: async (userConfig, resolveConfigurationVariable, next) => {
    const resolvedConfig = await next(userConfig, resolveConfigurationVariable);
    const resolved = resolveKmsUserConfig(userConfig, resolvedConfig, resolveConfigurationVariable);
    log(
      "keys: %s",
      Object.values(resolved.kms.keys)
        .map((key) => key.displayId)
        .join(", ") || "none",
    );
    for (const [network, config] of Object.entries(resolved.networks)) {
      if (config.kmsAccounts.length > 0) {
        log("network %s: %s", network, config.kmsAccounts.map((key) => key.displayId).join(", "));
      }
    }
    return resolved;
  },
});
