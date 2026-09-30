import type { KmsProviderDescriptor } from "../types.ts";
import { wrongProvider } from "../wrong-provider.ts";
import { awsKeySchema, resolveAwsKey } from "./config.ts";

/** The AWS KMS provider. */
export const awsProvider: KmsProviderDescriptor = {
  id: "aws",
  schema: awsKeySchema,
  resolve: (key, context) =>
    key.provider === "aws" ? resolveAwsKey(key, context) : wrongProvider("aws", key.provider),
  name: "AWS KMS",
  adapter: { package: "hardhat-kms-aws" },
};
