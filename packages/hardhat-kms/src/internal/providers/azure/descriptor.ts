import type { KmsProviderDescriptor } from "../types.ts";
import { wrongProvider } from "../wrong-provider.ts";
import { azureKeySchema, resolveAzureKey } from "./config.ts";

/** The Azure Key Vault provider. */
export const azureProvider: KmsProviderDescriptor = {
  id: "azure",
  schema: azureKeySchema,
  resolve: (key, context) =>
    key.provider === "azure" ? resolveAzureKey(key, context) : wrongProvider("azure", key.provider),
  name: "Azure Key Vault",
  adapter: { package: "@hardhat-kms/azure" },
};
