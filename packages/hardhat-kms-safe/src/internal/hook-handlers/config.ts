import { catalogMessage } from "hardhat-kms/provider-utils";
import type { ConfigHooks, HardhatUserConfigValidationError } from "hardhat/types/hooks";

import { ERRORS } from "../error-catalog.ts";
import { DEFAULT_TIMEOUT_MS, isServiceUrl } from "../tx-service.ts";

/**
 * Whether a value is a configuration variable, as `configVariable()` returns it.
 *
 * @param value - The value.
 * @returns Whether it is one.
 */
function isConfigurationVariable(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "_type") === "ConfigurationVariable" &&
    typeof Reflect.get(value, "name") === "string"
  );
}

/**
 * The problems of a `kmsSafe` section.
 *
 * @param section - `kmsSafe` from the user's config.
 * @returns One entry per problem.
 */
export function validateKmsSafe(section: unknown): HardhatUserConfigValidationError[] {
  if (section === undefined) {
    return [];
  }
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    return [{ path: ["kmsSafe"], message: catalogMessage(ERRORS.section, {}) }];
  }
  const errors: HardhatUserConfigValidationError[] = [];
  const apiKey: unknown = Reflect.get(section, "apiKey");
  if (apiKey !== undefined && !isConfigurationVariable(apiKey)) {
    errors.push({ path: ["kmsSafe", "apiKey"], message: catalogMessage(ERRORS.apiKeyLiteral, {}) });
  }
  const services: unknown = Reflect.get(section, "services");
  if (services !== undefined) {
    if (typeof services !== "object" || services === null || Array.isArray(services)) {
      errors.push({ path: ["kmsSafe", "services"], message: catalogMessage(ERRORS.section, {}) });
    } else {
      for (const [chainId, url] of Object.entries(services)) {
        if (!/^[1-9]\d{0,77}$/.test(chainId)) {
          errors.push({
            path: ["kmsSafe", "services", chainId],
            message: catalogMessage(ERRORS.serviceChainId, {}),
          });
        } else if (typeof url !== "string" || !isServiceUrl(url)) {
          errors.push({
            path: ["kmsSafe", "services", chainId],
            message: catalogMessage(ERRORS.serviceUrl, {}),
          });
        }
      }
    }
  }
  const timeoutMs: unknown = Reflect.get(section, "timeoutMs");
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1000 ||
      timeoutMs > 300_000)
  ) {
    errors.push({ path: ["kmsSafe", "timeoutMs"], message: catalogMessage(ERRORS.timeout, {}) });
  }
  const known = new Set(["apiKey", "services", "timeoutMs"]);
  for (const key of Object.keys(section)) {
    if (!known.has(key)) {
      errors.push({
        path: ["kmsSafe", key],
        message: catalogMessage(ERRORS.section, {}),
      });
    }
  }
  return errors;
}

/**
 * Validates and resolves `kmsSafe`. The API key must be a configuration variable: a key written in
 * the config file would be committed with it. Its value is read only when a proposal goes to the
 * service.
 *
 * @returns The handlers.
 */
export default async (): Promise<Partial<ConfigHooks>> => ({
  validateUserConfig: async (userConfig) => validateKmsSafe(userConfig.kmsSafe),
  resolveUserConfig: async (userConfig, resolveConfigurationVariable, next) => {
    const resolved = await next(userConfig, resolveConfigurationVariable);
    const section = userConfig.kmsSafe;
    const apiKey = section?.apiKey;
    return {
      ...resolved,
      kmsSafe: {
        apiKey: apiKey === undefined ? undefined : resolveConfigurationVariable(apiKey),
        services: { ...section?.services },
        timeoutMs: section?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
    };
  },
});
