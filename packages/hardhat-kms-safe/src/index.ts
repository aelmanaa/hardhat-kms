/**
 * The `@hardhat-kms/safe` package: signs Safe multisig transactions with a hardhat-kms key and
 * proposes them to the Safe Transaction Service. The default export is the Hardhat plugin, which
 * adds `kms safe propose` and the `kmsSafe` config section; `proposeSafeTransaction` does the
 * same from code.
 *
 * @module @hardhat-kms/safe
 */

/// <reference types="hardhat-kms/types" preserve="true" />
import { emptyTask, task } from "hardhat/config";
import { definePlugin } from "hardhat/plugins";
import { ArgumentType } from "hardhat/types/arguments";
import type { HardhatPlugin } from "hardhat/types/plugins";

export type * from "./type-extensions.ts";

/**
 * The @hardhat-kms/safe plugin: `kms safe propose` signs a Safe transaction with an owner the
 * network signs for, a KMS account by default or the `--from` address, and proposes it to the Safe
 * Transaction Service. It loads hardhat-kms itself.
 *
 * Add it to the `plugins` array of your Hardhat config, next to the provider package of a KMS key
 * if one signs.
 */
const hardhatKmsSafePlugin: HardhatPlugin = definePlugin({
  id: "@hardhat-kms/safe",
  npmPackage: "@hardhat-kms/safe",
  dependencies: () => [import("hardhat-kms")],
  hookHandlers: {
    config: () => import("./internal/hook-handlers/config.ts"),
  },
  tasks: [
    emptyTask(["kms", "safe"], "Propose Safe multisig transactions from a Hardhat account").build(),
    task(["kms", "safe", "propose"], "Sign a Safe transaction with an owner and propose it")
      .addPositionalArgument({
        name: "safe",
        type: ArgumentType.STRING,
        description: "The Safe's address",
      })
      .addPositionalArgument({
        name: "to",
        type: ArgumentType.STRING,
        description: "The address the Safe calls",
      })
      .addOption({
        name: "value",
        type: ArgumentType.BIGINT,
        defaultValue: 0n,
        description: "Wei the Safe sends with the call",
      })
      .addOption({
        name: "data",
        type: ArgumentType.STRING_WITHOUT_DEFAULT,
        defaultValue: undefined,
        description: "The call data, 0x-prefixed hex; none by default",
      })
      .addOption({
        name: "function",
        type: ArgumentType.STRING_WITHOUT_DEFAULT,
        defaultValue: undefined,
        description:
          'A function to encode the call data from, such as "transferOwnership(address)"',
      })
      .addOption({
        name: "args",
        type: ArgumentType.STRING_WITHOUT_DEFAULT,
        defaultValue: undefined,
        description: "The function's arguments as a JSON array; requires --function",
      })
      .addOption({
        name: "key",
        type: ArgumentType.STRING_WITHOUT_DEFAULT,
        defaultValue: undefined,
        description:
          "The owner's KMS key, as the kms tasks take it; the network's only KMS account by default",
      })
      .addOption({
        name: "from",
        type: ArgumentType.STRING_WITHOUT_DEFAULT,
        defaultValue: undefined,
        description:
          "The owner's address: a key in the network's accounts, a Ledger or a KMS account",
      })
      .addOption({
        name: "nonce",
        type: ArgumentType.STRING_WITHOUT_DEFAULT,
        defaultValue: undefined,
        description: "The Safe nonce; by default the next one after the queued transactions",
      })
      .addFlag({
        name: "delegatecall",
        description: "Propose a delegatecall (operation 1): the target's code runs as the Safe",
      })
      .addFlag({
        name: "yes",
        description: "Propose to a Safe with threshold 1 without asking",
      })
      .setAction(() => import("./internal/tasks/propose.ts"))
      .build(),
  ],
});

export default hardhatKmsSafePlugin;
export {
  proposeSafeTransaction,
  type ProposeSafeTransactionOptions,
  type SafeProposal,
  type SafeTransactionReview,
} from "./internal/propose.ts";
export { assertProposerSignsInProcess } from "./internal/proposer.ts";
export { TransactionServiceClient, type TransactionServiceOptions } from "./internal/tx-service.ts";
export { SERVICE_CHAINS, safeAppLink, serviceFor } from "./internal/chains.ts";
export {
  SUPPORTED_VERSIONS,
  safeTxHash,
  type Operation,
  type SafeCall,
  type SafeTransaction,
  type SupportedVersion,
} from "./internal/safe-tx.ts";
export type { Eip1193Provider } from "./internal/safe-contract.ts";
