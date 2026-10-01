import { HardhatError } from "@nomicfoundation/hardhat-errors";
import { HardhatPluginError } from "hardhat/plugins";
import type { HookContext } from "hardhat/types/hooks";

import type { KmsKeyConfig } from "../../types.ts";
import { kmsDebug } from "../debug.ts";
import { errorName, kmsError } from "../errors.ts";
import type { KmsKeyAdapter } from "../signer/types.ts";
import { builtinProvider } from "./registry.ts";

const log = kmsDebug("providers");

const SIGNING_METHODS = ["signDigest", "signMessage", "signTypedData"] as const;
const IDENTITY_METHODS = ["getPublicKey", "getAddress"] as const;
const OPTIONAL_METHODS = [...SIGNING_METHODS, ...IDENTITY_METHODS, "close"] as const;

/**
 * Checks that an adapter a handler returned implements the contract, so a broken third-party
 * provider fails with a clear error at creation rather than on its first signature.
 *
 * @param adapter - What the handler returned.
 * @param key - The key it was created for.
 * @throws A `HardhatPluginError` that says what is missing.
 */
function assertAdapter(adapter: unknown, key: KmsKeyConfig): asserts adapter is KmsKeyAdapter {
  const problem = adapterProblem(adapter, key);
  if (problem !== undefined) {
    throw kmsError(problem, {
      provider: key.provider,
      operation: "create adapter",
      key: key.displayId,
    });
  }
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
    return `the adapter's describe() failed (${errorName(error)})`;
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
 * Explains why no handler claimed a key: its provider package is missing, its adapter is not
 * written yet, or no plugin provides its provider.
 */
function unclaimedKeyError(key: KmsKeyConfig): Error {
  const details = { provider: key.provider, operation: "create adapter", key: key.displayId };
  const provider = builtinProvider(key.provider);
  if (provider === undefined) {
    return kmsError(
      `no plugin provides "${key.provider}" keys. Add the plugin for this provider to \`plugins\` in your Hardhat config, or check the \`provider\` field`,
      details,
    );
  }
  if ("issue" in provider.adapter) {
    return kmsError(
      `signing with ${provider.name} keys is not available yet (https://github.com/aelmanaa/hardhat-kms/issues/${provider.adapter.issue})`,
      details,
    );
  }
  const name = provider.adapter.package;
  return kmsError(
    `${provider.name} keys need the ${name} plugin. Install it with \`npm install --save-dev ${name}\` and add it to \`plugins\` in your Hardhat config`,
    details,
  );
}

/**
 * Builds the adapter for a key: runs the `kms.createKeyAdapter` hook chain. Provider plugins,
 * first-party ones included, claim their keys there; a key that no handler claims fails.
 *
 * @param context - The Hardhat runtime.
 * @param key - The resolved key.
 * @returns The key's adapter, checked against the contract.
 */
export async function createKeyAdapter(
  context: HookContext,
  key: KmsKeyConfig,
): Promise<KmsKeyAdapter> {
  log("creating the adapter for %s", key.displayId);
  let adapter: unknown;
  try {
    adapter = await context.hooks.runHandlerChain(
      "kms",
      "createKeyAdapter",
      [key],
      async (_finalContext, finalKey) => {
        log("%s: no plugin claimed the key", finalKey.displayId);
        return await Promise.reject(unclaimedKeyError(finalKey));
      },
    );
  } catch (error) {
    // Hardhat and plugin errors are written to be shown; a missing configuration variable, for
    // example, names the variable but never a value. Anything else, such as a failed SDK import or
    // a client constructor error, may carry request details: keep only its class name, as the
    // signer does.
    if (HardhatPluginError.isHardhatPluginError(error) || HardhatError.isHardhatError(error)) {
      throw error;
    }
    log("%s: creating the adapter failed (%s)", key.displayId, errorName(error));
    throw kmsError(`creating the adapter failed (${errorName(error)})`, {
      provider: key.provider,
      operation: "create adapter",
      key: key.displayId,
    });
  }
  try {
    assertAdapter(adapter, key);
  } catch (error) {
    await closeRefused(adapter);
    throw error;
  }
  return adapter;
}

/**
 * Closes an adapter that failed the contract check, if it has a `close` method, so its clients do
 * not keep the process running. Its own errors are dropped: the check's error is the one to report.
 *
 * @param adapter - What the handler returned.
 */
async function closeRefused(adapter: unknown): Promise<void> {
  if (typeof adapter !== "object" || adapter === null) {
    return;
  }
  const close: unknown = Reflect.get(adapter, "close");
  if (typeof close !== "function") {
    return;
  }
  try {
    const closing: unknown = Reflect.apply(close, adapter, []);
    await closing;
  } catch {
    // Nothing more to release.
  }
}
