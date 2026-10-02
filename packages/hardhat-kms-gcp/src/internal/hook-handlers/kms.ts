import { createRequire } from "node:module";

import { checkProviderVersion, internalError } from "hardhat-kms/provider-utils";
import type { KmsHooks } from "hardhat-kms/types";

import type { GcpKmsSdk } from "../adapter.ts";
import { ERRORS } from "../error-catalog.ts";

const PACKAGE_NAME = "hardhat-kms-gcp";

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
 * The user-agent tag on every Cloud KMS request, which Cloud Audit Logs records as
 * `callerSuppliedUserAgent`. The version check below makes this package's version the core's too,
 * so one `hardhat-kms/<version>` tag serves all providers. The tag is reported by the client:
 * anyone can send the same string.
 *
 * @param version - This package's version.
 * @returns The tag, such as `hardhat-kms/1.0.0`.
 */
export function pluginUserAgent(version: string): string {
  return `hardhat-kms/${version}`;
}

/** Loads @google-cloud/kms, and the google-gax this package depends on for it to run on. */
async function loadSdk(): Promise<GcpKmsSdk> {
  const [kms, gax] = await Promise.all([import("@google-cloud/kms"), import("google-gax")]);
  return { KeyManagementServiceClient: kms.KeyManagementServiceClient, gax: gax.default };
}

/**
 * The `kms` hook handlers: build adapters for `gcp` keys and pass every other key on. The adapter
 * module, and with it the Google Cloud SDK, loads only when a Google Cloud key is first used.
 * Before that, the handler checks that hardhat-kms is the same version as this package.
 *
 * @param version - This package's version; tests pass another one to cause a mismatch.
 * @param sdk - Loads the SDK; tests pass one whose clients talk to a local server.
 * @returns The handlers.
 */
export function kmsHandlers(
  version: string = ownVersion(),
  sdk: () => Promise<GcpKmsSdk> = loadSdk,
): Partial<KmsHooks> {
  return {
    createKeyAdapter: async (context, key, next) => {
      if (key.provider !== "gcp") {
        return await next(context, key);
      }
      checkProviderVersion(PACKAGE_NAME, version, {
        provider: "gcp",
        operation: "create adapter",
        key: key.displayId,
      });
      const { createGcpKeyAdapter } = await import("../adapter.ts");
      return await createGcpKeyAdapter(key, await sdk(), pluginUserAgent(version));
    },
  };
}

/**
 * Loaded by Hardhat when the `kms` hook first runs.
 *
 * @returns The handlers.
 */
export default async (): Promise<Partial<KmsHooks>> => await Promise.resolve(kmsHandlers());
