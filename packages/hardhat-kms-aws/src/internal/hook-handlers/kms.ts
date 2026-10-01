import { createRequire } from "node:module";

import { checkProviderVersion } from "hardhat-kms/provider-utils";
import type { KmsHooks } from "hardhat-kms/types";

const PACKAGE_NAME = "hardhat-kms-aws";

/** This package's version, read through its own `package.json` export. */
function ownVersion(): string {
  const manifest: unknown = createRequire(import.meta.url)(`${PACKAGE_NAME}/package.json`);
  const version: unknown =
    typeof manifest === "object" && manifest !== null
      ? Reflect.get(manifest, "version")
      : undefined;
  if (typeof version !== "string" || version === "") {
    throw new Error(`${PACKAGE_NAME}/package.json has no version`);
  }
  return version;
}

/**
 * The `kms` hook handlers: build adapters for `aws` keys and pass every other key on. The adapter
 * module, and with it the AWS SDK, loads only when an AWS key is first used. Before that, the
 * handler checks that hardhat-kms is the same version as this package.
 *
 * @param version - This package's version; tests pass another one to cause a mismatch.
 * @returns The handlers.
 */
export function kmsHandlers(version: string = ownVersion()): Partial<KmsHooks> {
  return {
    createKeyAdapter: async (context, key, next) => {
      if (key.provider !== "aws") {
        return await next(context, key);
      }
      checkProviderVersion(PACKAGE_NAME, version, {
        provider: "aws",
        operation: "create adapter",
        key: key.displayId,
      });
      const { createAwsKeyAdapter } = await import("../adapter.ts");
      return await createAwsKeyAdapter(key, await import("@aws-sdk/client-kms"));
    },
  };
}

/**
 * Loaded by Hardhat when the `kms` hook first runs.
 *
 * @returns The handlers.
 */
export default async (): Promise<Partial<KmsHooks>> => await Promise.resolve(kmsHandlers());
