import { createRequire } from "node:module";

import { checkProviderVersion, internalError } from "hardhat-kms/provider-utils";
import type { AzureKmsKeyConfig, KmsHooks, KmsKeyAdapter } from "hardhat-kms/types";

import { ERRORS } from "../error-catalog.ts";
import type { QueryWorkspace } from "../history.ts";

/** The npm name this handler checks its version under; it must equal the manifest name. */
export const PACKAGE_NAME = "@hardhat-kms/azure";

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
 * Loads the SDK, builds the credential and returns the adapter factory that uses them, with the
 * user-agent tag for every Key Vault request. Tests pass a loader that builds adapters on fakes,
 * or on the real SDK with a fake HTTP client.
 */
export type AzureAdapterFactoryLoader = (userAgent: string) => Promise<AzureAdapterFactory>;

/**
 * The user-agent tag on every Key Vault request, which the Key Vault audit log records. The version
 * check makes this package's version the core's too, so one `hardhat-kms/<version>` tag serves all
 * providers. The tag is reported by the client: anyone can send the same string.
 *
 * @param version - This package's version.
 * @returns The tag, such as `hardhat-kms/1.0.0`.
 */
export function pluginUserAgent(version: string): string {
  return `hardhat-kms/${version}`;
}

/**
 * The environment the credential chain reads its variables from, for signing and reading: the
 * service principal's, and `AZURE_CLIENT_ID` for a user-assigned managed identity.
 */
function azureEnvironment(): NodeJS.ProcessEnv {
  // oxlint-disable-next-line node/no-process-env -- the plugin selects the service principal itself, to refuse username and password sign-in, and ManagedIdentityCredential does not read AZURE_CLIENT_ID itself
  return process.env;
}

/** Loads @azure/keyvault-keys and @azure/identity, and builds the credential chain. */
const loadAdapterFactory: AzureAdapterFactoryLoader = async (userAgent) => {
  const [keyVault, identity, { createAzureCredential }, { createAzureKeyAdapter }] =
    await Promise.all([
      import("@azure/keyvault-keys"),
      import("@azure/identity"),
      import("../credential.ts"),
      import("../adapter.ts"),
    ]);
  const credential = createAzureCredential(identity, azureEnvironment());
  return async (key) => await createAzureKeyAdapter(key, keyVault, credential, userAgent);
};

/**
 * Loads the history reader's query call: builds the credential chain, as for signing, and the Log
 * Analytics query through @azure/core-rest-pipeline. Tests pass a loader whose call answers in
 * process.
 */
export type AzureHistoryQueryLoader = (userAgent: string) => Promise<QueryWorkspace>;

/** Loads @azure/identity and the Log Analytics call, and builds the credential chain. */
const loadHistoryQuery: AzureHistoryQueryLoader = async (userAgent) => {
  const [identity, { createAzureCredential }, { logAnalyticsQuery }] = await Promise.all([
    import("@azure/identity"),
    import("../credential.ts"),
    import("../log-analytics.ts"),
  ]);
  const credential = createAzureCredential(identity, azureEnvironment());
  return logAnalyticsQuery(credential, userAgent);
};

/**
 * The `kms` hook handlers: build adapters for `azure` keys and read their history from Log
 * Analytics, and pass every other key on. The adapter module, and with it the Azure SDK, loads
 * only when an Azure key is first used; the history reader and its query call only when
 * `kms history` reads an Azure key. Before either, the handler checks that hardhat-kms is the
 * same version as this package. All Azure keys of a runtime share one credential, so the chain
 * runs once per scope, not once per key.
 *
 * @param version - This package's version; tests pass another one to cause a mismatch.
 * @param load - Loads the SDK and the credential once, on the first Azure key; tests pass fakes.
 * @param history - Loads the Log Analytics query call; tests pass one that answers in process.
 * @returns The handlers.
 */
export function kmsHandlers(
  version: string = ownVersion(),
  load: AzureAdapterFactoryLoader = loadAdapterFactory,
  history: AzureHistoryQueryLoader = loadHistoryQuery,
): Partial<KmsHooks> {
  let factory: Promise<AzureAdapterFactory> | undefined;
  return {
    readSignHistory: async (context, request, next) => {
      const { key } = request;
      if (key.provider !== "azure") {
        return await next(context, request);
      }
      checkProviderVersion(PACKAGE_NAME, version, {
        provider: "azure",
        operation: "history",
        key: key.displayId,
      });
      const [{ readAzureSignHistory }, query] = await Promise.all([
        import("../history.ts"),
        history(pluginUserAgent(version)),
      ]);
      return await readAzureSignHistory(key, context.config.kms.audit, request, query);
    },
    createKeyAdapter: async (context, key, next) => {
      if (key.provider !== "azure") {
        return await next(context, key);
      }
      checkProviderVersion(PACKAGE_NAME, version, {
        provider: "azure",
        operation: "create adapter",
        key: key.displayId,
      });
      factory ??= load(pluginUserAgent(version));
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
