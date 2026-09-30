import { kmsError } from "../errors.ts";
import { loadSdk } from "./sdk.ts";
import type { KmsProviderDescriptor, ProviderDeps } from "./types.ts";

/**
 * Builds what a provider's adapter receives. `loadSdk` only loads the packages the descriptor
 * declares, so every SDK a provider uses goes through the version check.
 *
 * @param descriptor - The provider.
 * @param projectRoot - The Hardhat project root.
 * @returns The provider's dependencies.
 */
export function createProviderDeps(
  descriptor: KmsProviderDescriptor,
  projectRoot: string,
): ProviderDeps {
  return {
    loadSdk: async (packageName) => {
      const sdk = descriptor.sdks.find((candidate) => candidate.packageName === packageName);
      if (sdk === undefined) {
        throw kmsError(`the provider does not declare ${packageName} among its SDKs`, {
          provider: descriptor.id,
          operation: "load SDK",
        });
      }
      return await loadSdk(sdk, projectRoot, descriptor.id);
    },
  };
}
