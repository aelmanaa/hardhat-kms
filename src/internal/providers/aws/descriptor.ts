import type { KmsProviderDescriptor } from "../types.ts";
import { wrongProvider } from "../wrong-provider.ts";
import { awsKeySchema, resolveAwsKey } from "./config.ts";

/** The AWS KMS provider. Importing it does not import the SDK. */
export const awsProvider: KmsProviderDescriptor = {
  id: "aws",
  schema: awsKeySchema,
  resolve: (key, context) =>
    key.provider === "aws" ? resolveAwsKey(key, context) : wrongProvider("aws", key.provider),
  // 3.714.0 is the first version whose client takes the region from its `profile`.
  sdks: [{ packageName: "@aws-sdk/client-kms", range: "^3.714.0" }],
  load: async () => (await import("./adapter.ts")).awsModule,
};
