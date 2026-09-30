import { definePlugin } from "hardhat/plugins";
import type { HardhatPlugin } from "hardhat/types/plugins";

import { PLUGIN_ID } from "./internal/constants.ts";

/**
 * The hardhat-kms plugin: sign transactions, messages and typed data with keys
 * held in AWS KMS, GCP Cloud KMS and Azure Key Vault / Managed HSM.
 *
 * Add it to the `plugins` array of your Hardhat config.
 */
const hardhatKmsPlugin: HardhatPlugin = definePlugin({
  id: PLUGIN_ID,
  npmPackage: "hardhat-kms",
  hookHandlers: {},
});

export default hardhatKmsPlugin;
