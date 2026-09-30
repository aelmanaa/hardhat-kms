import { definePlugin } from "hardhat/plugins";
import type { HardhatPlugin } from "hardhat/types/plugins";

import { PLUGIN_ID } from "./internal/constants.ts";

export type * from "./type-extensions.ts";

/**
 * The hardhat-kms plugin: sign transactions, messages and typed data with keys held in AWS KMS,
 * Google Cloud KMS and Azure Key Vault or Managed HSM.
 *
 * Add it to the `plugins` array of your Hardhat config.
 */
const hardhatKmsPlugin: HardhatPlugin = definePlugin({
  id: PLUGIN_ID,
  npmPackage: "hardhat-kms",
  hookHandlers: {
    config: () => import("./internal/hook-handlers/config.ts"),
  },
});

export default hardhatKmsPlugin;
