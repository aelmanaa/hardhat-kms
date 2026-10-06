import type { HardhatRuntimeEnvironmentHooks, HookContext } from "hardhat/types/hooks";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";

import type { KmsKeyConfig } from "../../types.ts";
import { keysFromKmsOption } from "../config/env-keys.ts";
import { coreDebug } from "../debug.ts";

const log = coreDebug("config");
const keysByRuntime = new WeakMap<object, readonly KmsKeyConfig[]>();

/**
 * The keys selected with `--kms` for this runtime, in order. The network hook adds them to the
 * selected network's accounts.
 *
 * @param runtime - The Hardhat runtime, or the context a hook handler receives. Hardhat builds
 * hook contexts with the runtime as their prototype, so both find the same keys.
 * @returns The keys; empty when `--kms` was not given.
 */
export function commandLineKeys(
  runtime: HardhatRuntimeEnvironment | HookContext,
): readonly KmsKeyConfig[] {
  for (
    let current: object | null = runtime;
    current !== null;
    current = Reflect.getPrototypeOf(current)
  ) {
    const keys = keysByRuntime.get(current);
    if (keys !== undefined) {
      return keys;
    }
  }
  return [];
}

/**
 * Runtime hook handlers: read `--kms` when the runtime is created, so a mistake fails before any
 * task runs.
 *
 * @returns The handlers.
 */
export default async (): Promise<Partial<HardhatRuntimeEnvironmentHooks>> => ({
  created: async (_context, hre) => {
    // An empty value turns the option off, as `HARDHAT_KMS=` does for other environment settings.
    const option = hre.globalOptions.kms?.trim() ?? "";
    if (option === "") {
      return;
    }
    if (hre.globalOptions.help) {
      // Help must work even when --kms or HARDHAT_KMS is wrong: it is how users find out why.
      log("--kms %s: not read while showing help", option);
      return;
    }
    // Foundry's variables are read from the environment directly (decision 0008).
    // oxlint-disable-next-line node/no-process-env -- the documented exception for --kms
    const keys = await keysFromKmsOption(option, process.env, hre.config.kms.defaults);
    keysByRuntime.set(hre, Object.freeze(keys));
    log("--kms %s: %s", option, keys.map((key) => key.displayId).join(", "));
  },
});
