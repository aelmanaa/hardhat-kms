import { createRequire } from "node:module";

import { checkProviderVersion, internalError } from "hardhat-kms/provider-utils";
import type { KmsHooks, KmsKeyAdapter, TurnkeyKmsKeyConfig } from "hardhat-kms/types";

import { ERRORS } from "../error-catalog.ts";

/** The npm name this handler checks its version under; it must equal the manifest name. */
export const PACKAGE_NAME = "@hardhat-kms/turnkey";

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

/** Builds the adapter for one Turnkey key. */
export type TurnkeyAdapterFactory = (key: TurnkeyKmsKeyConfig) => Promise<KmsKeyAdapter>;

/**
 * Loads the adapter module and returns the factory that builds adapters with it. Tests pass a
 * loader whose factory points the adapter at a local Turnkey stub; users cannot change Turnkey's
 * API URL.
 */
export type TurnkeyAdapterFactoryLoader = () => Promise<TurnkeyAdapterFactory>;

/** Loads the adapter, which talks to Turnkey's API. */
const loadAdapterFactory: TurnkeyAdapterFactoryLoader = async () => {
  const { createTurnkeyKeyAdapter } = await import("../adapter.ts");
  return async (key) => await createTurnkeyKeyAdapter(key);
};

/**
 * The `kms` hook handler: builds adapters for `turnkey` keys and passes every other key on. The
 * adapter module loads only when a Turnkey key is first used. Before that, the handler checks that
 * hardhat-kms is the same version as this package.
 *
 * @param version - This package's version; tests pass another one to cause a mismatch.
 * @param load - Loads the adapter module once, on the first Turnkey key; tests pass one that
 *   points the adapter at a local stub.
 * @returns The handlers.
 */
export function kmsHandlers(
  version: string = ownVersion(),
  load: TurnkeyAdapterFactoryLoader = loadAdapterFactory,
): Partial<KmsHooks> {
  let factory: Promise<TurnkeyAdapterFactory> | undefined;
  return {
    createKeyAdapter: async (context, key, next) => {
      if (key.provider !== "turnkey") {
        return await next(context, key);
      }
      checkProviderVersion(PACKAGE_NAME, version, {
        provider: "turnkey",
        operation: "create adapter",
        key: key.displayId,
      });
      factory ??= load();
      let create: TurnkeyAdapterFactory;
      try {
        create = await factory;
      } catch (error) {
        // Let the next Turnkey key try again.
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
