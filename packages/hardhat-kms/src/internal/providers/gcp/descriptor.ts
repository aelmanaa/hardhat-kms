import type { KmsProviderDescriptor } from "../types.ts";
import { wrongProvider } from "../wrong-provider.ts";
import { gcpKeySchema, resolveGcpKey } from "./config.ts";

/** The Google Cloud KMS provider. */
export const gcpProvider: KmsProviderDescriptor = {
  id: "gcp",
  schema: gcpKeySchema,
  resolve: (key, context) =>
    key.provider === "gcp" ? resolveGcpKey(key, context) : wrongProvider("gcp", key.provider),
  name: "Google Cloud KMS",
  adapter: { package: "hardhat-kms-gcp" },
};
