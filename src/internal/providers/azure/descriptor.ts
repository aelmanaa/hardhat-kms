import { notYetAvailable } from "../not-yet-available.ts";
import type { KmsProviderDescriptor } from "../types.ts";
import { wrongProvider } from "../wrong-provider.ts";
import { azureKeySchema, resolveAzureKey } from "./config.ts";

/** The Azure Key Vault provider. Importing it does not import the SDK. */
export const azureProvider: KmsProviderDescriptor = {
  id: "azure",
  schema: azureKeySchema,
  resolve: (key, context) =>
    key.provider === "azure" ? resolveAzureKey(key, context) : wrongProvider("azure", key.provider),
  sdks: [
    { packageName: "@azure/keyvault-keys", range: "^4.0.0" },
    { packageName: "@azure/identity", range: "^4.0.0" },
  ],
  load: async () => await notYetAvailable("Azure Key Vault", 30),
};
