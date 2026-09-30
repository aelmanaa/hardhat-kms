import { createDebug } from "@nomicfoundation/hardhat-utils/debug";

/** A value a debug line may contain. Objects and errors are refused: they print whole. */
type DebugValue = string | number | bigint | boolean | undefined;

/** A logger that only accepts plain values; see {@link kmsDebug}. */
export interface KmsDebugLogger {
  (format: string, ...values: DebugValue[]): void;
  readonly enabled: boolean;
}

/**
 * Makes a value safe to print on one debug line: control characters are escaped, so a key or
 * network name cannot forge extra lines, and anything that is not a plain value is replaced.
 *
 * @param value - The value.
 * @returns The printable value.
 */
function printable(value: unknown): DebugValue {
  if (typeof value === "string") {
    // oxlint-disable-next-line eslint/no-control-regex -- matching control characters is the point
    return value.replaceAll(/[\u0000-\u001f\u007f-\u009f]/g, (character) =>
      JSON.stringify(character).slice(1, -1),
    );
  }
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    value === undefined
  ) {
    return value;
  }
  return `[redacted ${value === null ? "null" : typeof value}]`;
}

/**
 * Creates a logger under the plugin's `hardhat:kms:*` debug namespace. It writes to standard error
 * when `DEBUG` matches, for example `DEBUG=hardhat:kms:*`, and `DEBUG` is read when the logger is
 * created.
 *
 * Log only what is safe to print: display ids, addresses, digests, provider ids, operation names,
 * the plugin's own request ids, timings, error class names and SDK package details. Never log
 * configuration variable values, credentials, a provider's request details or its error text.
 * The logger accepts plain values only, and replaces any object or error it is given.
 *
 * @param namespace - The sub-namespace, such as `signer`.
 * @returns The logger.
 */
export function kmsDebug(namespace: string): KmsDebugLogger {
  const log = createDebug(`hardhat:kms:${namespace}`);
  const safe = (format: string, ...values: DebugValue[]): void => {
    if (log.enabled) {
      log(format, ...values.map(printable));
    }
  };
  return Object.freeze(Object.assign(safe, { enabled: log.enabled }));
}
