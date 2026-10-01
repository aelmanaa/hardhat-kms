import type { ConfigurationVariable, ConfigurationVariableResolver } from "hardhat/types/config";

import type { KmsIdentifier, KmsIdentifierUserConfig } from "../../types.ts";
import { kmsError } from "../errors.ts";

/**
 * Checks an identifier's value.
 *
 * @param value - The value, trimmed.
 * @returns An error message, or `undefined` if the value is valid.
 */
export type IdentifierCheck = (value: string) => string | undefined;

/**
 * Checks whether a config value is a configuration variable.
 *
 * @param value - Any config value.
 * @returns Whether it is a `configVariable(...)` object.
 */
export function isConfigurationVariable(value: unknown): value is ConfigurationVariable {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "_type") === "ConfigurationVariable"
  );
}

function checked(
  value: string,
  check: IdentifierCheck | undefined,
  path: string,
  display: string,
): string {
  const problem = check?.(value);
  if (problem !== undefined) {
    // The message names the config path and the display form, never the value, which may come
    // from a configuration variable.
    throw kmsError(`invalid value for ${path} (${display}): ${problem}`);
  }
  return value;
}

/**
 * Resolves an identifier. Its value is read and checked only when `get()` is called, so values
 * from configuration variables get the same checks as literal values. Its display form never
 * contains a configuration variable's value.
 *
 * @param value - A literal string or a configuration variable.
 * @param resolveVariable - Hardhat's configuration variable resolver.
 * @param path - The config path, for error messages.
 * @param check - Validates the value.
 * @returns The resolved identifier.
 */
export function resolveIdentifier(
  value: KmsIdentifierUserConfig,
  resolveVariable: ConfigurationVariableResolver,
  path: string,
  check?: IdentifierCheck,
): KmsIdentifier {
  const resolved = resolveVariable(value);
  const display = isConfigurationVariable(value) ? `<${value.name}>` : value;
  return {
    get: async () => checked((await resolved.get()).trim(), check, path, display),
    display,
  };
}

type PartValues<Parts> = { [K in keyof Parts]: string };

/** Parts keyed by name, each a resolved identifier. */
type IdentifierParts<Parts> = { [K in keyof Parts]: KmsIdentifier };

function hasEveryPart<Parts extends object>(
  parts: Parts,
  values: Partial<PartValues<Parts>>,
): values is PartValues<Parts> {
  return Object.keys(parts).every((key) => typeof Reflect.get(values, key) === "string");
}

function mapParts<Parts extends IdentifierParts<Parts>>(
  parts: Parts,
  value: (part: KmsIdentifier) => string,
): PartValues<Parts> {
  const values: Partial<PartValues<Parts>> = {};
  for (const key in parts) {
    values[key] = value(parts[key]);
  }
  if (!hasEveryPart(parts, values)) {
    throw new Error("an identifier part has no value");
  }
  return values;
}

/**
 * Joins identifiers into one, for ids built from components (a GCP key version name, an Azure
 * key URL). The joined value is checked, not only the parts.
 *
 * @param build - Builds the joined value from the parts' values or display forms.
 * @param parts - The resolved parts.
 * @param path - The config path, for error messages.
 * @param check - Validates the joined value.
 * @returns The joined identifier.
 */
export function joinIdentifiers<Parts extends IdentifierParts<Parts>>(
  build: (parts: PartValues<Parts>) => string,
  parts: Parts,
  path: string,
  check?: IdentifierCheck,
): KmsIdentifier {
  const display = build(mapParts(parts, (part) => part.display));
  const list: KmsIdentifier[] = [];
  for (const key in parts) {
    list.push(parts[key]);
  }
  return {
    get: async () => {
      const values = new Map<KmsIdentifier, string>(
        await Promise.all(list.map(async (part) => [part, await part.get()] as const)),
      );
      return checked(
        build(mapParts(parts, (part) => values.get(part) ?? "")),
        check,
        path,
        display,
      );
    },
    display,
  };
}
