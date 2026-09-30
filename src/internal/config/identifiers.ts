import type { ConfigurationVariable, ConfigurationVariableResolver } from "hardhat/types/config";

import type { KmsIdentifier, KmsIdentifierUserConfig } from "../../types.ts";

/**
 * Checks whether a config value is a configuration variable.
 *
 * @param value - Any config value.
 * @returns Whether it is a `configVariable(...)` object.
 */
function isConfigurationVariable(value: unknown): value is ConfigurationVariable {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _type?: unknown })._type === "ConfigurationVariable"
  );
}

/**
 * Resolves an identifier. Its value is read only when `get()` is called; its display form never
 * contains a configuration variable's value.
 *
 * @param value - A literal string or a configuration variable.
 * @param resolveVariable - Hardhat's configuration variable resolver.
 * @returns The resolved identifier.
 */
export function resolveIdentifier(
  value: KmsIdentifierUserConfig,
  resolveVariable: ConfigurationVariableResolver,
): KmsIdentifier {
  const resolved = resolveVariable(value);
  return {
    get: async () => (await resolved.get()).trim(),
    display: isConfigurationVariable(value) ? `<${value.name}>` : value,
  };
}

type PartValues<Parts> = { [K in keyof Parts]: string };

function mapParts<Parts extends Record<string, KmsIdentifier>>(
  parts: Parts,
  value: (part: KmsIdentifier) => string,
): PartValues<Parts> {
  const values = Object.fromEntries(Object.entries(parts).map(([key, part]) => [key, value(part)]));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- rebuilt with exactly the keys of `parts`
  return values as PartValues<Parts>;
}

/**
 * Joins identifiers into one, for ids built from components (a GCP key version name, an Azure
 * key URL).
 *
 * @param build - Builds the joined value from the parts' values or display forms.
 * @param parts - The resolved parts.
 * @returns The joined identifier.
 */
export function joinIdentifiers<Parts extends Record<string, KmsIdentifier>>(
  build: (parts: PartValues<Parts>) => string,
  parts: Parts,
): KmsIdentifier {
  return {
    get: async () => {
      const values = new Map<KmsIdentifier, string>(
        await Promise.all(
          Object.values(parts).map(async (part) => [part, await part.get()] as const),
        ),
      );
      return build(mapParts(parts, (part) => values.get(part) ?? ""));
    },
    display: build(mapParts(parts, (part) => part.display)),
  };
}
