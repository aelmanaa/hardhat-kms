import { validateUserConfigZodType } from "@nomicfoundation/hardhat-zod-utils";
import type { HardhatUserConfig } from "hardhat/config";
import type { HardhatUserConfigValidationError } from "hardhat/types/hooks";

import { kmsUserConfigSchema } from "./schema.ts";

/**
 * Validates the `kms` section and every network's `kmsAccounts`.
 *
 * @param userConfig - The user's Hardhat config.
 * @returns The validation errors, each with its path from the config root.
 */
export function validateKmsUserConfig(
  userConfig: HardhatUserConfig,
): HardhatUserConfigValidationError[] {
  return validateUserConfigZodType(userConfig, kmsUserConfigSchema);
}
