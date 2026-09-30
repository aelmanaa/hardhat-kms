import type { HookContext } from "hardhat/types/hooks";

import type { KmsKeyConfig } from "../../types.ts";
import { kmsError } from "../errors.ts";
import type { KmsKeyAdapter } from "../signer/types.ts";
import { createProviderDeps } from "./deps.ts";
import { builtinProvider } from "./registry.ts";

const SIGNING_METHODS = ["signDigest", "signMessage", "signTypedData"] as const;
const IDENTITY_METHODS = ["getPublicKey", "getAddress"] as const;
const OPTIONAL_METHODS = [...SIGNING_METHODS, ...IDENTITY_METHODS, "close"] as const;

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
    throw kmsError(problem, {
      provider: key.provider,
      operation: "create adapter",
      key: key.displayId,
    });
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked by adapterProblem
  return adapter as KmsKeyAdapter;
}

function adapterProblem(adapter: unknown, key: KmsKeyConfig): string | undefined {
  if (adapter === undefined || adapter === null) {
    return "a kms.createKeyAdapter handler returned nothing for this key. Handlers must return `await next(context, key)` for keys of other providers";
  }
  if (typeof adapter !== "object") {
    return "the adapter for this key is not an object";
  }
  const method = (name: string): unknown => Reflect.get(adapter, name);
  const has = (name: string): boolean => typeof method(name) === "function";
  if (!has("describe")) {
    return "the adapter for this key has no describe() method";
  }
  const notFunction = OPTIONAL_METHODS.find((name) => method(name) !== undefined && !has(name));
  if (notFunction !== undefined) {
    return `the adapter's ${notFunction} is not a function`;
  }
  if (!SIGNING_METHODS.some(has)) {
    return `the adapter for this key has no signing method (${SIGNING_METHODS.join(", ")})`;
  }
  if (!IDENTITY_METHODS.some(has) && key.address === undefined) {
    return "the adapter for this key can neither return a public key nor an address, and the key has no `address` pin";
  }
  return describeProblem(adapter);
}

function describeProblem(adapter: object): string | undefined {
  const describe: unknown = Reflect.get(adapter, "describe");
  if (typeof describe !== "function") {
    return "the adapter for this key has no describe() method";
  }
  let description: unknown;
  try {
    description = Reflect.apply(describe, adapter, []);
  } catch (error) {
    // Only the class name: a provider's error text may carry request details.
    return `the adapter's describe() failed (${error instanceof Error ? error.constructor.name : typeof error})`;
  }
  const field = (name: string): unknown =>
    typeof description === "object" && description !== null
      ? Reflect.get(description, name)
      : undefined;
  const missing = ["provider", "pinnedId", "displayId"].filter((name) => {
    const value = field(name);
    return typeof value !== "string" || value === "";
  });
  return missing.length === 0
    ? undefined
    : `the adapter's describe() must return non-empty strings for ${missing.join(", ")}`;
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
