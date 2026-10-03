import { createRequire } from "node:module";

import { checkProviderVersion, internalError } from "hardhat-kms/provider-utils";
import type { KmsHooks } from "hardhat-kms/types";

import { ERRORS } from "../error-catalog.ts";

/** The npm name this handler checks its version under; it must equal the manifest name. */
export const PACKAGE_NAME = "@hardhat-kms/aws";

/** This package's version, read through its own `package.json` export. */
function ownVersion(): string {
  const manifest: unknown = createRequire(import.meta.url)(`${PACKAGE_NAME}/package.json`);
  const version: unknown =
    typeof manifest === "object" && manifest !== null
      ? Reflect.get(manifest, "version")
      : undefined;
  if (typeof version !== "string" || version === "") {
    throw internalError(ERRORS.noPackageVersion, { packageName: PACKAGE_NAME });
  }
  return version;
}

/**
 * The user-agent tag on every KMS request, which CloudTrail records. The version check below makes
 * this package's version the core's too, so one `hardhat-kms/<version>` tag serves all providers.
 * The tag is reported by the client: anyone can send the same string.
 *
 * @param version - This package's version.
 * @returns The tag, such as `hardhat-kms/1.0.0`.
 */
export function pluginUserAgent(version: string): string {
  return `hardhat-kms/${version}`;
}

/**
 * The `kms` hook handlers: build adapters for `aws` keys, read their sign history from CloudTrail,
 * and pass every other key on. The adapter module, and with it the AWS SDK, loads only when an AWS
 * key is first used; the history reader and the CloudTrail and STS SDKs only when `kms history`
 * reads an AWS key. Before either, the handler checks that hardhat-kms is the same version as this
 * package.
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
      return await createAwsKeyAdapter(
        key,
        await import("@aws-sdk/client-kms"),
        pluginUserAgent(version),
      );
    },
    readSignHistory: async (context, request, next) => {
      const { key } = request;
      if (key.provider !== "aws") {
        return await next(context, request);
      }
      checkProviderVersion(PACKAGE_NAME, version, {
        provider: "aws",
        operation: "history",
        key: key.displayId,
      });
      const [{ readAwsSignHistory }, { createAwsHistoryApi }] = await Promise.all([
        import("../history.ts"),
        import("../history-api.ts"),
      ]);
      const api = await createAwsHistoryApi(
        key,
        await key.keyId.get(),
        {
          cloudTrail: async () => await import("@aws-sdk/client-cloudtrail"),
          sts: async () => await import("@aws-sdk/client-sts"),
          kms: async () => await import("@aws-sdk/client-kms"),
        },
        pluginUserAgent(version),
      );
      try {
        return await readAwsSignHistory(key, request, api);
      } finally {
        api.close();
      }
    },
  };
}

/**
 * Loaded by Hardhat when the `kms` hook first runs.
 *
 * @returns The handlers.
 */
export default async (): Promise<Partial<KmsHooks>> => await Promise.resolve(kmsHandlers());
