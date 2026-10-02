import { createRequire } from "node:module";

import { checkProviderVersion, internalError } from "hardhat-kms/provider-utils";
import type { AzureKmsKeyConfig, KmsHooks, KmsKeyAdapter } from "hardhat-kms/types";

import { ERRORS } from "../error-catalog.ts";

const PACKAGE_NAME = "hardhat-kms-azure";

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

/** Builds the adapter for one Azure key. */
export type AzureAdapterFactory = (key: AzureKmsKeyConfig) => Promise<KmsKeyAdapter>;

/**
 * Loads the SDK, builds the credential and returns the adapter factory that uses them. Tests pass
 * a loader that builds adapters on fakes, or on the real SDK with a fake HTTP client.
 */
export type AzureAdapterFactoryLoader = () => Promise<AzureAdapterFactory>;

/** Loads @azure/keyvault-keys and @azure/identity, and builds the credential chain. */
const loadAdapterFactory: AzureAdapterFactoryLoader = async () => {
  const [keyVault, identity, { createAzureCredential }, { createAzureKeyAdapter }] =
    await Promise.all([
      import("@azure/keyvault-keys"),
      import("@azure/identity"),
      import("../credential.ts"),
      import("../adapter.ts"),
    ]);
  // oxlint-disable-next-line node/no-process-env -- ManagedIdentityCredential does not read AZURE_CLIENT_ID itself, and DefaultAzureCredential has another order than Foundry's
  const credential = createAzureCredential(identity, process.env.AZURE_CLIENT_ID);
  return async (key) => await createAzureKeyAdapter(key, keyVault, credential);
};

/**
 * The `kms` hook handlers: build adapters for `azure` keys and pass every other key on. The
 * adapter module, and with it the Azure SDK, loads only when an Azure key is first used. Before
 * that, the handler checks that hardhat-kms is the same version as this package. All Azure keys of
 * a runtime share one credential, so the chain runs once per scope, not once per key.
 *
 * @param version - This package's version; tests pass another one to cause a mismatch.
 * @param load - Loads the SDK and the credential once, on the first Azure key; tests pass fakes.
 * @returns The handlers.
 */
export function kmsHandlers(
  version: string = ownVersion(),
  load: AzureAdapterFactoryLoader = loadAdapterFactory,
): Partial<KmsHooks> {
  let factory: Promise<AzureAdapterFactory> | undefined;
  return {
    createKeyAdapter: async (context, key, next) => {
      if (key.provider !== "azure") {
        return await next(context, key);
      }
      checkProviderVersion(PACKAGE_NAME, version, {
        provider: "azure",
        operation: "create adapter",
        key: key.displayId,
      });
      factory ??= load();
      let create: AzureAdapterFactory;
      try {
        create = await factory;
      } catch (error) {
        // Let the next Azure key try again.
        factory = undefined;
        throw error;
      }
      return await create(key);
    },
  };
}

/**
 * Loaded by Hardhat when the `kms` hook first runs.
 *
 * @returns The handlers.
 */
export default async (): Promise<Partial<KmsHooks>> => await Promise.resolve(kmsHandlers());
