/**
 * The hardhat-kms plugin, as the default export. Importing it also adds the `kms` config section
 * and each network's `kmsAccounts` to Hardhat's config types.
 *
 * @module hardhat-kms
 */

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
    task(["kms", "accounts"], "List the KMS keys, check each one and show its address")
      .addFlag({ name: "json", description: "Print the list as JSON" })
      .addFlag({
        name: "showIds",
        description: "Show key ids in full, including values read from configuration variables",
      })
      .addFlag({
        name: "balances",
        description: "Show each address's balance on the --network network",
      })
      .addFlag({
        name: "checkSign",
        description: "Have each key sign a random message, to check that it may sign",
      })
      .setAction(() => import("./internal/tasks/accounts.ts"))
      .build(),
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
    task(["kms", "sign-tx"], "Fill and sign a transaction on --network, without sending it")
      .addPositionalArgument({
        name: "key",
        type: ArgumentType.STRING,
        description: KEY_ARGUMENT_DESCRIPTION,
      })
      .addPositionalArgument({
        name: "tx",
        type: ArgumentType.STRING,
        description: "Path to a JSON file with the transaction, in eth_sendTransaction fields",
      })
      .setAction(() => import("./internal/tasks/sign-tx.ts"))
      .build(),
    task(["kms", "sign-auth"], "Sign an EIP-7702 authorization with a KMS key")
      .addPositionalArgument({
        name: "key",
        type: ArgumentType.STRING,
        description: KEY_ARGUMENT_DESCRIPTION,
      })
      .addPositionalArgument({
        name: "delegate",
        type: ArgumentType.STRING,
        description: "The address of the code the key's account delegates to",
      })
      .addOption({
        name: "chain",
        description: "The chain id to sign for; required unless --network is given",
        type: ArgumentType.STRING_WITHOUT_DEFAULT,
        defaultValue: undefined,
      })
      .addOption({
        name: "nonce",
        description: "The authority's nonce; read from the --network node when omitted",
        type: ArgumentType.STRING_WITHOUT_DEFAULT,
        defaultValue: undefined,
      })
      .addFlag({
        name: "selfBroadcast",
        description:
          "Sign for the pending nonce + 1, for when this key will send the transaction that carries the authorization. The task sends nothing",
      })
      .addFlag({
        name: "force",
        description: "Allow chain 0, which makes the authorization valid on every chain",
      })
      .setAction(() => import("./internal/tasks/sign-auth.ts"))
      .build(),
    task(["kms", "history"], "List a KMS key's sign events from its provider's audit log")
      .addPositionalArgument({
        name: "key",
        type: ArgumentType.STRING,
        description: KEY_ARGUMENT_DESCRIPTION,
      })
      .addOption({
        name: "since",
        description:
          "Start of the range: an ISO 8601 time with a time zone, a date, or a duration before now such as 6h or 7d. Default: 24 hours before --until",
        type: ArgumentType.STRING_WITHOUT_DEFAULT,
        defaultValue: undefined,
      })
      .addOption({
        name: "until",
        description: "End of the range, in the same forms as --since. Default: now",
        type: ArgumentType.STRING_WITHOUT_DEFAULT,
        defaultValue: undefined,
      })
      .addOption({
        name: "limit",
        description: "At most this many events, the newest ones (1 to 1000)",
        type: ArgumentType.INT,
        defaultValue: 100,
      })
      .addFlag({ name: "json", description: "Print the events as JSON" })
      .addFlag({
        name: "showIds",
        description: "Show key ids, provider id fields and error messages in full",
      })
      .setAction(() => import("./internal/tasks/history.ts"))
      .build(),
  ],
  globalOptions: [
    globalOption({
      name: "kms",
      description:
        "Load KMS keys from environment variables for these providers: aws, gcp, azure (comma-separated). aws and gcp use Foundry's variables; azure uses the names proposed in foundry-rs/foundry#17120",
      type: ArgumentType.STRING_WITHOUT_DEFAULT,
      defaultValue: undefined,
    }),
  ],
});

export default hardhatKmsPlugin;
