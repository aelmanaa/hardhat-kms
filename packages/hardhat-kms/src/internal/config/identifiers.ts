import type { ConfigurationVariable, ConfigurationVariableResolver } from "hardhat/types/config";

import type { KmsIdentifier, KmsIdentifierUserConfig } from "../../types.ts";
import { coreDebug } from "../debug.ts";
import { ERRORS } from "../error-catalog.ts";
import { catalogError, errorName, internalError } from "../errors.ts";

const log = coreDebug("config");

/**
 * Checks an identifier's value. A check may read another identifier, such as the AWS key `region`
 * that a key ARN must agree with, so it may return a promise.
 *
 * @param value - The value, trimmed.
 * @returns An error message, or `undefined` if the value is valid.
 */
export type IdentifierCheck = (value: string) => string | undefined | Promise<string | undefined>;

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

/**
 * Each resolved identifier's comparison form: the identifier as written in the config, built
 * without reading any configuration variable. A literal gives its value; a configuration variable
 * gives every field Hardhat resolves it with (its name, `format` and `default`); a joined
 * identifier gives its parts' forms, joined the way the value is. Two identifiers with the same
 * form resolve to the same value in one runtime.
 *
 * Never print or log a comparison form: a variable's `default` can be a secret. It is kept here,
 * not on the identifier, so that printing or inspecting a resolved config cannot show it.
 */
const comparisonForms = new WeakMap<KmsIdentifier, string>();

/**
 * The parts of each joined identifier, such as the project, location, key ring, key and version of
 * a Google Cloud key version name, and the candidates of each `firstSetIdentifier`. Kept here,
 * not on the identifier, as the comparison forms are.
 */
const joinedParts = new WeakMap<KmsIdentifier, readonly KmsIdentifier[]>();

/**
 * Returns the parts a joined identifier was built from, so that `kms history` can hide the value
 * of each part that comes from a configuration variable.
 *
 * @param identifier - A resolved identifier.
 * @returns Its parts, or an empty list for an identifier that is not joined.
 */
export function identifierParts(identifier: KmsIdentifier): readonly KmsIdentifier[] {
  return joinedParts.get(identifier) ?? [];
}

/**
 * Returns an identifier's comparison form, for telling whether two keys name the same KMS key.
 * Never print or log the result.
 *
 * @param identifier - A resolved identifier.
 * @returns Its comparison form, or `undefined` for an identifier that config resolution did not
 * build.
 */
export function identifierComparisonForm(identifier: KmsIdentifier): string | undefined {
  return comparisonForms.get(identifier);
}

/** The comparison form of a literal or a configuration variable, read from the raw config. */
function writtenForm(value: KmsIdentifierUserConfig): string {
  if (!isConfigurationVariable(value)) {
    return JSON.stringify(["literal", value]);
  }
  // Every field but the marker, so a field Hardhat adds later is compared too. A field set to
  // `undefined` counts as absent, as it does for Hardhat.
  const fields = Object.entries(value)
    .filter(([field, fieldValue]) => field !== "_type" && fieldValue !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(["variable", fields]);
}

async function checked(
  value: string,
  check: IdentifierCheck | undefined,
  path: string,
  display: string,
): Promise<string> {
  const problem = await check?.(value);
  if (problem !== undefined) {
    // The message names the config path and the display form, never the value, which may come
    // from a configuration variable.
    throw catalogError(ERRORS.invalidValue, { path, display, problem });
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
  const identifier: KmsIdentifier = {
    get: async () => {
      let read: string;
      try {
        read = await resolved.get();
      } catch (error) {
        // Hardhat's error names the variable but not where the config uses it; this line adds
        // the config path. The error passes on unchanged.
        log("%s: reading %s failed (%s)", path, display, errorName(error));
        throw error;
      }
      return await checked(read.trim(), check, path, display);
    },
    display,
  };
  comparisonForms.set(identifier, writtenForm(value));
  return identifier;
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
    throw internalError(ERRORS.identifierPartMissing, {});
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
  const identifier: KmsIdentifier = {
    get: async () => {
      const values = new Map<KmsIdentifier, string>(
        await Promise.all(list.map(async (part) => [part, await part.get()] as const)),
      );
      return await checked(
        build(mapParts(parts, (part) => values.get(part) ?? "")),
        check,
        path,
        display,
      );
    },
    display,
  };
  joinedParts.set(identifier, list);
  // The parts' forms are JSON, whose escaping keeps them apart wherever `build` puts them.
  if (list.every((part) => comparisonForms.has(part))) {
    const forms = mapParts(parts, (part) => comparisonForms.get(part) ?? "");
    comparisonForms.set(identifier, JSON.stringify(["joined", build(forms)]));
  }
  return identifier;
}

/**
 * The first of several identifiers whose value is not empty, or an empty value when all are empty.
 * It reads the candidates in order and stops at the first value, so a later candidate is read only
 * when every earlier one is empty. It stands for a setting with fallbacks, such as an AWS key's
 * `region` from a configuration variable, then `kms.defaults.aws.region`.
 *
 * Its display form joins the candidates' display forms with ` or `. Its comparison form joins
 * theirs, and its parts are the candidates, so `kms history` hides each candidate's variable value.
 *
 * @param candidates - The identifiers, first choice first.
 * @returns The identifier.
 */
export function firstSetIdentifier(candidates: readonly KmsIdentifier[]): KmsIdentifier {
  const identifier: KmsIdentifier = {
    get: async () => {
      for (const candidate of candidates) {
        const value = await candidate.get();
        if (value !== "") {
          return value;
        }
      }
      return "";
    },
    display: candidates.map((candidate) => candidate.display).join(" or "),
  };
  joinedParts.set(identifier, [...candidates]);
  const forms = candidates.map((candidate) => comparisonForms.get(candidate));
  if (forms.every((form) => form !== undefined)) {
    comparisonForms.set(identifier, JSON.stringify(["first", forms]));
  }
  return identifier;
}
