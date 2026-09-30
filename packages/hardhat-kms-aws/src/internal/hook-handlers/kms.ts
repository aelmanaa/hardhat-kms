import type { KmsHooks } from "hardhat-kms/types";

/**
 * `kms` hook handlers: build adapters for `aws` keys and pass every other key on. The adapter
 * module, and with it the AWS SDK, loads only when an AWS key is first used.
 *
 * @returns The handlers.
 */
export default async (): Promise<Partial<KmsHooks>> => ({
  createKeyAdapter: async (context, key, next) => {
    if (key.provider !== "aws") {
      return await next(context, key);
    }
    const { createAwsKeyAdapter } = await import("../adapter.ts");
    return await createAwsKeyAdapter(key, await import("@aws-sdk/client-kms"));
  },
});
