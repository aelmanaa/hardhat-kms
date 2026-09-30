import { createDebug, type DebugLogger } from "@nomicfoundation/hardhat-utils/debug";

/**
 * Creates a logger in the plugin's `hardhat:kms:*` debug namespace, enabled with
 * `DEBUG=hardhat:kms:*`.
 *
 * Log only what is safe to print: display ids, addresses, digests, provider ids, timings and
 * error class names. Never log configuration variable values, credentials, request metadata or a
 * provider's error text.
 *
 * @param namespace - The sub-namespace, such as `signer`.
 * @returns The logger.
 */
export function kmsDebug(namespace: string): DebugLogger {
  return createDebug(`hardhat:kms:${namespace}`);
}
