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
    task(["kms", "sign"], "Sign a message, typed data or a raw digest with a KMS key")
      .addPositionalArgument({
        name: "key",
        type: ArgumentType.STRING,
        description: KEY_ARGUMENT_DESCRIPTION,
      })
      .addPositionalArgument({
        name: "message",
        type: ArgumentType.STRING,
        description:
          "The message (0x-prefixed hex is bytes, anything else UTF-8), the typed data with --data, or the 32-byte digest with --no-hash",
      })
      .addFlag({
        name: "data",
        description: "Sign the message as EIP-712 typed data in JSON",
      })
      .addFlag({
        name: "fromFile",
        description: "Read the typed data from the file the message names; requires --data",
      })
      .addFlag({
        name: "noHash",
        description:
          "Sign the message as a raw 32-byte digest, with no EIP-191 prefix. Only for digests you computed yourself",
      })
      .addOption({
        name: "chain",
        description:
          "With --data: the chain the typed data must be for, instead of the --network connection's",
        type: ArgumentType.STRING_WITHOUT_DEFAULT,
        defaultValue: undefined,
      })
      .addFlag({
        name: "allowCrossChain",
        description: "With --data: sign typed data whatever chain its domain names",
      })
      .setAction(() => import("./internal/tasks/sign.ts"))
      .build(),
    task(["kms", "verify"], "Check that an address signed a message or typed data")
      .addPositionalArgument({
        name: "message",
        type: ArgumentType.STRING,
        description:
          "The message (0x-prefixed hex is bytes, anything else UTF-8), or the typed data with --data",
      })
      .addPositionalArgument({
        name: "signature",
        type: ArgumentType.STRING,
        description: "The 65-byte r || s || v signature, as kms sign and personal_sign return it",
      })
      .addOption({
        name: "address",
        description: "The expected signer's address; no KMS call",
        type: ArgumentType.STRING_WITHOUT_DEFAULT,
        defaultValue: undefined,
      })
      .addOption({
        name: "key",
        description:
          "The expected signer as a key name, as in kms address; the KMS returns its address",
        type: ArgumentType.STRING_WITHOUT_DEFAULT,
        defaultValue: undefined,
      })
      .addFlag({
        name: "data",
        description: "Verify the message as EIP-712 typed data in JSON",
      })
      .addFlag({
        name: "fromFile",
        description: "Read the typed data from the file the message names; requires --data",
      })
      .setAction(() => import("./internal/tasks/verify.ts"))
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
