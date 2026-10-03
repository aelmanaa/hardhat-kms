import { createDebug } from "@nomicfoundation/hardhat-utils/debug";

import { ERRORS } from "./error-catalog.ts";
import { catalogError } from "./errors.ts";

/**
 * A namespace: 1 to 64 lowercase letters, digits and `-`, starting with a letter, such as
 * `signer`.
 */
const NAMESPACE = /^[a-z][a-z0-9-]{0,63}$/;

/** The namespaces hardhat-kms logs under. {@link kmsDebug} refuses them. */
export const CORE_NAMESPACES = [
  "account",
  "config",
  "history",
  "providers",
  "rpc",
  "signer",
] as const;

/** A namespace hardhat-kms logs under. */
export type CoreNamespace = (typeof CORE_NAMESPACES)[number];

const RESERVED: ReadonlySet<string> = new Set(CORE_NAMESPACES);

/** A value a debug line may contain. Objects and errors are refused: they print whole. */
export type DebugValue = string | number | bigint | boolean | undefined;

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
 * Creates a logger under `hardhat:kms:<namespace>`, without checking the namespace.
 *
 * @param namespace - The sub-namespace.
 * @returns The logger.
 */
function createLogger(namespace: string): KmsDebugLogger {
  const log = createDebug(`hardhat:kms:${namespace}`);
  const safe = (format: string, ...values: DebugValue[]): void => {
    if (log.enabled) {
      log(format, ...values.map(printable));
    }
  };
  return Object.freeze(Object.assign(safe, { enabled: log.enabled }));
}

/**
 * Creates a logger under one of the core's own namespaces. For hardhat-kms itself; a provider
 * package uses {@link kmsDebug}.
 *
 * @param namespace - The core's namespace.
 * @returns The logger.
 */
export function coreDebug(namespace: CoreNamespace): KmsDebugLogger {
  return createLogger(namespace);
}

/**
 * Creates a logger under the plugin's `hardhat:kms:*` debug namespace, for a provider package. It
 * writes to standard error when `DEBUG` matches, for example `DEBUG=hardhat:kms:*`, and `DEBUG` is
 * read when the logger is created.
 *
 * A provider package logs under its provider id, such as `azure` or `myvault`. The namespaces of
 * hardhat-kms itself (`account`, `config`, `history`, `providers`, `rpc` and `signer`) are refused,
 * so a provider's lines cannot pass for the core's.
 *
 * Log only what is safe to print: display ids, addresses, digests, provider ids, operation names,
 * the plugin's own request ids, timings, error class names and SDK package details. Never log
 * configuration variable values, credentials, a provider's request details or its error text.
 * The logger accepts plain values only, and replaces any object or error it is given. A string is
 * printed as given, with only its control characters escaped, so never pass a variable's value or
 * a secret. Write the format as a string literal and pass every value through a `%s` or `%d`
 * placeholder: text built into the format is neither type-checked nor escaped.
 *
 * @param namespace - The sub-namespace: the provider id, made of 1 to 64 lowercase letters,
 *   digits and `-`, starting with a letter.
 * @returns The logger.
 * @throws A `HardhatPluginError`: `core.provider.debug-namespace-reserved` for one of the core's
 *   namespaces, and `core.provider.debug-namespace-invalid` for a name in any other form.
 */
export function kmsDebug(namespace: string): KmsDebugLogger {
  if (!NAMESPACE.test(namespace)) {
    throw catalogError(ERRORS.debugNamespaceInvalid, { namespace: JSON.stringify(namespace) });
  }
  if (RESERVED.has(namespace)) {
    throw catalogError(ERRORS.debugNamespaceReserved, {
      namespace: JSON.stringify(namespace),
      reserved: CORE_NAMESPACES.join(", "),
    });
  }
  return createLogger(namespace);
}
