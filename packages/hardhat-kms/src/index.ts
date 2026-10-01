import { globalOption } from "hardhat/config";
import { definePlugin } from "hardhat/plugins";
import { ArgumentType } from "hardhat/types/arguments";
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
    hre: () => import("./internal/hook-handlers/hre.ts"),
    network: () => import("./internal/hook-handlers/network.ts"),
  },
  globalOptions: [
    globalOption({
      name: "kms",
      description:
        "Load KMS keys from Foundry's environment variables for these providers: aws, gcp, azure (comma-separated)",
      type: ArgumentType.STRING_WITHOUT_DEFAULT,
      defaultValue: undefined,
    }),
  ],
});

export default hardhatKmsPlugin;
