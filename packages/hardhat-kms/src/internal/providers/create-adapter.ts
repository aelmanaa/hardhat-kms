import { HardhatError } from "@nomicfoundation/hardhat-errors";
import { HardhatPluginError } from "hardhat/plugins";
import type { HookContext } from "hardhat/types/hooks";

import type { KmsKeyConfig } from "../../types.ts";
import { kmsDebug } from "../debug.ts";
import { ERRORS } from "../error-catalog.ts";
import { catalogError, type ErrorDetails, errorName } from "../errors.ts";
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
  const problem = adapterProblem(adapter, key, {
    provider: key.provider,
    operation: "create adapter",
    key: key.displayId,
  });
  if (problem !== undefined) {
    throw problem;
  }
}

function adapterProblem(
  adapter: unknown,
  key: KmsKeyConfig,
  details: ErrorDetails,
): Error | undefined {
  if (adapter === undefined || adapter === null) {
    return catalogError(ERRORS.adapterNothing, {}, details);
  }
  if (typeof adapter !== "object") {
    return catalogError(ERRORS.adapterNotObject, {}, details);
  }
  const method = (name: string): unknown => Reflect.get(adapter, name);
  const has = (name: string): boolean => typeof method(name) === "function";
  if (!has("describe")) {
    return catalogError(ERRORS.adapterNoDescribe, {}, details);
  }
  const notFunction = OPTIONAL_METHODS.find((name) => method(name) !== undefined && !has(name));
  if (notFunction !== undefined) {
    return catalogError(ERRORS.adapterNotFunction, { method: notFunction }, details);
  }
  if (!SIGNING_METHODS.some(has)) {
    return catalogError(ERRORS.adapterNoSigning, { methods: SIGNING_METHODS.join(", ") }, details);
  }
  if (!IDENTITY_METHODS.some(has) && key.address === undefined) {
    return catalogError(ERRORS.adapterNoIdentity, {}, details);
  }
  return describeProblem(adapter, details);
}

function describeProblem(adapter: object, details: ErrorDetails): Error | undefined {
  const describe: unknown = Reflect.get(adapter, "describe");
  if (typeof describe !== "function") {
    return catalogError(ERRORS.adapterNoDescribe, {}, details);
  }
  let description: unknown;
  try {
    description = Reflect.apply(describe, adapter, []);
  } catch (error) {
    // Only the class name: a provider's error text may carry request details.
    return catalogError(ERRORS.adapterDescribeFailed, { errorName: errorName(error) }, details);
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
    : catalogError(ERRORS.adapterDescribeFields, { fields: missing.join(", ") }, details);
}

/**
 * Explains why no handler claimed a key: its provider package is missing, its adapter is not
 * written yet, or no plugin provides its provider.
 */
function unclaimedKeyError(key: KmsKeyConfig): Error {
  const details = { provider: key.provider, operation: "create adapter", key: key.displayId };
  const provider = builtinProvider(key.provider);
  if (provider === undefined) {
    return catalogError(ERRORS.noPlugin, { provider: key.provider }, details);
  }
  if ("issue" in provider.adapter) {
    return catalogError(
      ERRORS.providerNotAvailable,
      { name: provider.name, issue: provider.adapter.issue },
      details,
    );
  }
  return catalogError(
    ERRORS.providerPackageMissing,
    { name: provider.name, package: provider.adapter.package },
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
    throw catalogError(
      ERRORS.adapterFailed,
      { errorName: errorName(error) },
      { provider: key.provider, operation: "create adapter", key: key.displayId },
    );
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
