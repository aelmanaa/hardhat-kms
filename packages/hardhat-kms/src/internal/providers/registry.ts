import { awsProvider } from "./aws/descriptor.ts";
import { azureProvider } from "./azure/descriptor.ts";
import { gcpProvider } from "./gcp/descriptor.ts";
import type { KmsProviderDescriptor } from "./types.ts";

function freezeDescriptor(descriptor: KmsProviderDescriptor): KmsProviderDescriptor {
  for (const sdk of descriptor.sdks) {
    Object.freeze(sdk);
  }
  Object.freeze(descriptor.sdks);
  return Object.freeze(descriptor);
}

/**
 * The built-in providers, by id. A new built-in provider needs its folder, its config types in
 * `src/types.ts` and an entry here. Third-party providers plug in through the `kms` hook instead.
 */
export const BUILTIN_PROVIDERS: Readonly<Record<string, KmsProviderDescriptor>> = Object.freeze({
  aws: freezeDescriptor(awsProvider),
  gcp: freezeDescriptor(gcpProvider),
  azure: freezeDescriptor(azureProvider),
});

/**
 * Finds a built-in provider.
 *
 * @param id - The provider id from a key's config.
 * @returns The descriptor, or `undefined` for third-party providers.
 */
export function builtinProvider(id: string): KmsProviderDescriptor | undefined {
  return Object.hasOwn(BUILTIN_PROVIDERS, id) ? BUILTIN_PROVIDERS[id] : undefined;
}
