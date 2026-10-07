import { awsProvider } from "./aws/descriptor.ts";
import { azureProvider } from "./azure/descriptor.ts";
import { gcpProvider } from "./gcp/descriptor.ts";
import type { KmsProviderDescriptor, ReservedProvider } from "./types.ts";

function freezeDescriptor(descriptor: KmsProviderDescriptor): KmsProviderDescriptor {
  Object.freeze(descriptor.adapter);
  return Object.freeze(descriptor);
}

/**
 * The first-party providers, by id. A new one needs its folder, its config types in
 * `src/types.ts`, an entry here and a provider package with its adapter. Third-party providers
 * plug in through the `kms` hook only.
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

/**
 * The provider ids the core keeps for first-party providers that are planned but not released,
 * by id. A key of one of these providers fails validation, so a third-party plugin cannot serve it
 * and the later core release cannot collide with one.
 */
export const RESERVED_PROVIDERS: Readonly<Record<string, ReservedProvider>> = Object.freeze({
  turnkey: Object.freeze({ id: "turnkey", name: "Turnkey", issue: 54 }),
  fireblocks: Object.freeze({ id: "fireblocks", name: "Fireblocks", issue: 55 }),
});

/**
 * Finds the reserved provider an id names, in any case, so that `Turnkey` is refused as well as
 * `turnkey`.
 *
 * @param id - The provider id from a key's config.
 * @returns The reserved provider, or `undefined` when the id is not reserved.
 */
export function reservedProvider(id: string): ReservedProvider | undefined {
  const lower = id.toLowerCase();
  return Object.hasOwn(RESERVED_PROVIDERS, lower) ? RESERVED_PROVIDERS[lower] : undefined;
}
