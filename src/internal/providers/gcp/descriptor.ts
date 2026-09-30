import { notYetAvailable } from "../not-yet-available.ts";
import type { KmsProviderDescriptor } from "../types.ts";
import { wrongProvider } from "../wrong-provider.ts";
import { gcpKeySchema, resolveGcpKey } from "./config.ts";

/** The Google Cloud KMS provider. Importing it does not import the SDK. */
export const gcpProvider: KmsProviderDescriptor = {
  id: "gcp",
  schema: gcpKeySchema,
  resolve: (key, context) =>
    key.provider === "gcp" ? resolveGcpKey(key, context) : wrongProvider("gcp", key.provider),
  sdks: [{ packageName: "@google-cloud/kms", range: "^6.0.0" }],
  load: async () => await notYetAvailable("Google Cloud KMS", 29),
};
