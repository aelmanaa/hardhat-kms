import type { ConfigHooks } from "hardhat/types/hooks";

import { resolveKmsUserConfig } from "../config/resolve.ts";
import { validateKmsUserConfig } from "../config/validate.ts";

/**
 * Config hook handlers: validate the `kms` section and `kmsAccounts`, then resolve them.
 *
 * @returns The handlers.
 */
export default async (): Promise<Partial<ConfigHooks>> => ({
  validateUserConfig: async (userConfig) => validateKmsUserConfig(userConfig),
  resolveUserConfig: async (userConfig, resolveConfigurationVariable, next) => {
    const resolvedConfig = await next(userConfig, resolveConfigurationVariable);
    return resolveKmsUserConfig(userConfig, resolvedConfig, resolveConfigurationVariable);
  },
});
