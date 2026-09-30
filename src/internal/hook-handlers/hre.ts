import type { HardhatRuntimeEnvironmentHooks } from "hardhat/types/hooks";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";

import type { KmsKeyConfig } from "../../types.ts";
import { keysFromKmsOption } from "../config/env-keys.ts";
import { kmsDebug } from "../debug.ts";

const log = kmsDebug("config");
const commandLineKeysByHre = new WeakMap<HardhatRuntimeEnvironment, readonly KmsKeyConfig[]>();

/**
 * The keys selected with `--kms` for this runtime, in order. The network hook adds them to the
 * selected network's accounts.
 *
 * @param hre - The Hardhat runtime.
 * @returns The keys; empty when `--kms` was not given.
 */
export function commandLineKeys(hre: HardhatRuntimeEnvironment): readonly KmsKeyConfig[] {
  return commandLineKeysByHre.get(hre) ?? [];
}

/**
 * Runtime hook handlers: read `--kms` when the runtime is created, so a mistake fails before any
 * task runs.
 *
 * @returns The handlers.
 */
export default async (): Promise<Partial<HardhatRuntimeEnvironmentHooks>> => ({
  created: async (_context, hre) => {
    const option = hre.globalOptions.kms;
    if (option === undefined) {
      return;
    }
    // Foundry's variables are read from the environment directly (decision 0008).
    // oxlint-disable-next-line node/no-process-env -- the documented exception for --kms
    const keys = await keysFromKmsOption(option, process.env, hre.config.kms.defaults);
    commandLineKeysByHre.set(hre, Object.freeze(keys));
    log("--kms %s: %s", option, keys.map((key) => key.displayId).join(", "));
  },
});
