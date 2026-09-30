import type { z } from "zod";

import type { KmsKeyConfig, KmsKeyUserConfig } from "../../types.ts";
import type { KeyResolveContext } from "../config/key-common.ts";
import type { KmsKeyAdapter } from "../signer/types.ts";

/** An npm package a provider needs at run time, and the versions it supports. */
export interface ProviderSdk {
  packageName: string;
  /** A semver range, for example `^3.0.0`. */
  range: string;
}

/** What the plugin gives a provider when it builds a key adapter. */
export interface ProviderDeps {
  /**
   * Loads one of the provider's SDK packages from the user's project, after checking that it is
   * installed and within the supported range.
   */
  loadSdk(packageName: string): Promise<unknown>;
}

/** The part of a provider that is only loaded when one of its keys is first used. */
export interface ProviderModule {
  createKeyAdapter(key: KmsKeyConfig, deps: ProviderDeps): Promise<KmsKeyAdapter>;
}

/**
 * Describes a provider. Importing a descriptor must never import the provider's SDK: the config
 * hook imports every descriptor, and loading a config must stay fast and work without the SDKs.
 */
export interface KmsProviderDescriptor {
  id: string;
  /** Validates a key's user config. */
  schema: z.ZodTypeAny;
  /** Resolves a validated key config. */
  resolve(key: KmsKeyUserConfig, context: KeyResolveContext): KmsKeyConfig;
  /** The SDK packages the provider loads when a key is first used. */
  sdks: readonly ProviderSdk[];
  /** Imports the provider's adapter code. */
  load(): Promise<ProviderModule>;
}
