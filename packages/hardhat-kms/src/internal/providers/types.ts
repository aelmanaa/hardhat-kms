import type { z } from "zod";

import type { KmsKeyConfig, KmsKeyUserConfig } from "../../types.ts";
import type { KeyResolveContext } from "../config/key-common.ts";

/** Where a first-party provider's adapter comes from. */
type ProviderAdapterSource =
  /** The npm package whose plugin adds the adapter through the `kms` hook. */
  | { package: string }
  /** The adapter is not written yet; the issue tracks it. */
  | { issue: number };

/**
 * Describes a first-party provider's key format. The config hook imports every descriptor; the
 * adapters live in the provider packages.
 */
export interface KmsProviderDescriptor {
  id: string;
  /** Validates a key's user config. */
  schema: z.ZodTypeAny;
  /** Resolves a validated key config. */
  resolve(key: KmsKeyUserConfig, context: KeyResolveContext): KmsKeyConfig;
  /** The provider's name in messages, for example `AWS KMS`. */
  name: string;
  adapter: ProviderAdapterSource;
}
