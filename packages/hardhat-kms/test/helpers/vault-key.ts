import type { KmsKeyCommonUserConfig, KmsKeyUserConfig } from "../../src/types.ts";

// The tests serve keys of a fake third-party provider, `myvault`, through the `kms` hook. A real
// provider plugin declares its key type the same way. This file is outside `src`, so the
// published types and `tsconfig.build.json` never see it.
declare module "../../src/types.ts" {
  interface KmsProviderUserConfigs {
    myvault: { provider: "myvault"; name: string } & KmsKeyCommonUserConfig;
  }
}

/**
 * A `myvault` key. The tests' `kms` hook handlers pick the fake adapter by `name`.
 *
 * @param name - The key name the fake adapter is chosen by.
 * @param address - The address to pin, if any.
 * @returns The key config.
 */
export function vaultKey(name: string, address?: string): KmsKeyUserConfig {
  return { provider: "myvault", name, ...(address === undefined ? {} : { address }) };
}
