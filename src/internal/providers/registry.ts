import { awsProvider } from "./aws/descriptor.ts";
import { azureProvider } from "./azure/descriptor.ts";
import { gcpProvider } from "./gcp/descriptor.ts";
import type { KmsProviderDescriptor } from "./types.ts";

/**
 * The built-in providers, by id. Adding a provider means adding its folder and one line here.
 * Third-party providers plug in through the `kms` hook instead.
 */
export const BUILTIN_PROVIDERS: Readonly<Record<string, KmsProviderDescriptor>> = Object.freeze({
  aws: awsProvider,
  gcp: gcpProvider,
  azure: azureProvider,
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
