import { HardhatPluginError } from "hardhat/plugins";

import { PLUGIN_ID } from "./constants.ts";

/**
 * The only details an error may carry. Everything here is safe to print: no credentials, no
 * tokens, no raw SDK error objects (they can hold request metadata and headers).
 */
export interface ErrorDetails {
  /** Provider id, for example `aws`. */
  provider?: string | undefined;
  /** What was being done, for example `sign` or `get public key`. */
  operation?: string | undefined;
  /** The key's display id (masked when it came from a configuration variable). */
  key?: string | undefined;
}

/**
 * Builds a `HardhatPluginError` from a message and allow-listed details.
 *
 * @param message - What went wrong and, when possible, how to fix it.
 * @param details - Optional context, limited to fields that are safe to print.
 * @returns The error to throw.
 */
export function kmsError(message: string, details: ErrorDetails = {}): HardhatPluginError {
  const context = [
    details.provider,
    details.operation,
    details.key === undefined ? undefined : `key ${details.key}`,
  ].filter((part) => part !== undefined);
  const prefix = context.length > 0 ? `${context.join(", ")}: ` : "";
  return new HardhatPluginError(PLUGIN_ID, `${prefix}${message}`);
}
