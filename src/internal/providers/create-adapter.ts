import type { HookContext } from "hardhat/types/hooks";

import type { KmsKeyConfig } from "../../types.ts";
import { kmsError } from "../errors.ts";
import type { KmsKeyAdapter } from "../signer/types.ts";
import { createProviderDeps } from "./deps.ts";
import { builtinProvider } from "./registry.ts";

const SIGNING_METHODS = ["signDigest", "signMessage", "signTypedData"] as const;

/**
 * Checks that an adapter a handler returned implements the contract, so a broken third-party
 * provider fails with a clear error at creation rather than on its first signature.
 *
 * @param adapter - What the handler returned.
 * @param key - The key it was created for.
 * @returns The adapter.
 */
function checkAdapter(adapter: unknown, key: KmsKeyConfig): KmsKeyAdapter {
  const problem = adapterProblem(adapter, key);
  if (problem !== undefined) {
    throw kmsError(`the adapter for this key ${problem}`, {
      provider: key.provider,
      operation: "create adapter",
      key: key.displayId,
    });
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked by adapterProblem
  return adapter as KmsKeyAdapter;
}

function adapterProblem(adapter: unknown, key: KmsKeyConfig): string | undefined {
  if (typeof adapter !== "object" || adapter === null) {
    return "is not an object";
  }
  const has = (method: string): boolean => typeof Reflect.get(adapter, method) === "function";
  if (!has("describe")) {
    return "has no describe() method";
  }
  if (!SIGNING_METHODS.some(has)) {
    return `has no signing method (${SIGNING_METHODS.join(", ")})`;
  }
  if (!has("getPublicKey") && !has("getAddress") && key.address === undefined) {
    return "can neither return a public key nor an address, and the key has no `address` pin";
  }
  return undefined;
}

/**
 * Builds the adapter for a key: runs the `kms.createKeyAdapter` hook chain, whose last step
 * handles the built-in providers.
 *
 * @param context - The Hardhat runtime.
 * @param key - The resolved key.
 * @returns The key's adapter, checked against the contract.
 */
export async function createKeyAdapter(
  context: HookContext,
  key: KmsKeyConfig,
): Promise<KmsKeyAdapter> {
  const adapter: unknown = await context.hooks.runHandlerChain(
    "kms",
    "createKeyAdapter",
    [key],
    async (finalContext, finalKey) => {
      const provider = builtinProvider(finalKey.provider);
      if (provider === undefined) {
        throw kmsError(
          `no plugin provides "${finalKey.provider}" keys. Add the plugin for this provider to \`plugins\` in your Hardhat config, or check the \`provider\` field`,
          { provider: finalKey.provider, operation: "create adapter", key: finalKey.displayId },
        );
      }
      const module = await provider.load();
      return await module.createKeyAdapter(
        finalKey,
        createProviderDeps(provider, finalContext.config.paths.root),
      );
    },
  );
  return checkAdapter(adapter, key);
}
