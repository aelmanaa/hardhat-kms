import { emptyTask, globalOption, task } from "hardhat/config";
import { definePlugin } from "hardhat/plugins";
import { ArgumentType } from "hardhat/types/arguments";
import type { HardhatPlugin } from "hardhat/types/plugins";

import { PLUGIN_ID } from "./internal/constants.ts";

export type * from "./type-extensions.ts";

/** How every `kms` task that takes a key describes its `key` argument. */
const KEY_ARGUMENT_DESCRIPTION =
  "The key: a name from kms.keys, an inline key such as sepolia.kmsAccounts[0], or a --kms key such as AWS_KMS_KEY_ID";

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
  tasks: [
    emptyTask("kms", "Inspect KMS keys and sign with them").build(),
    task(["kms", "address"], "Print a KMS key's address")
      .addPositionalArgument({
        name: "key",
        type: ArgumentType.STRING,
        description: KEY_ARGUMENT_DESCRIPTION,
      })
      .setAction(() => import("./internal/tasks/address.ts"))
      .build(),
    task(["kms", "public-key"], "Print a KMS key's uncompressed public key")
      .addPositionalArgument({
        name: "key",
        type: ArgumentType.STRING,
        description: KEY_ARGUMENT_DESCRIPTION,
      })
      .setAction(() => import("./internal/tasks/public-key.ts"))
      .build(),
  ],
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
