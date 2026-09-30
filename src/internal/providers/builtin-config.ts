import type { z } from "zod";

import type { KmsKeyConfig, KmsKeyUserConfig } from "../../types.ts";
import type { KeyResolveContext } from "../config/key-common.ts";
import { awsKeySchema, resolveAwsKey } from "./aws/config.ts";
import { azureKeySchema, resolveAzureKey } from "./azure/config.ts";
import { gcpKeySchema, resolveGcpKey } from "./gcp/config.ts";

/** How the config layer validates and resolves one built-in provider's keys. */
export interface BuiltinProviderConfig {
  schema: z.ZodTypeAny;
  resolve(key: KmsKeyUserConfig, context: KeyResolveContext): KmsKeyConfig;
}

function wrongProvider(expected: string, key: KmsKeyUserConfig): never {
  throw new Error(`Expected a "${expected}" key, got "${key.provider}"`);
}

/** The built-in providers' config handling, by provider id. */
export const BUILTIN_PROVIDER_CONFIGS: Readonly<Record<string, BuiltinProviderConfig>> = {
  aws: {
    schema: awsKeySchema,
    resolve: (key, context) =>
      key.provider === "aws" ? resolveAwsKey(key, context) : wrongProvider("aws", key),
  },
  gcp: {
    schema: gcpKeySchema,
    resolve: (key, context) =>
      key.provider === "gcp" ? resolveGcpKey(key, context) : wrongProvider("gcp", key),
  },
  azure: {
    schema: azureKeySchema,
    resolve: (key, context) =>
      key.provider === "azure" ? resolveAzureKey(key, context) : wrongProvider("azure", key),
  },
};
