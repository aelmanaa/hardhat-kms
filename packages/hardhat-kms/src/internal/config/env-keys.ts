import type {
  ConfigurationVariable,
  ConfigurationVariableResolver,
  ResolvedConfigurationVariable,
} from "hardhat/types/config";

import type {
  AwsKmsKeyUserConfig,
  AzureKmsKeyIdUserConfig,
  GcpKmsKeyComponentsUserConfig,
  KmsConfig,
  KmsKeyConfig,
  KmsKeyUserConfig,
} from "../../types.ts";
import { ERRORS } from "../error-catalog.ts";
import { catalogError, internalError } from "../errors.ts";
import { resolveKey } from "./resolve.ts";
import { builtinLookalike } from "./schema.ts";

/** The providers `--kms` accepts. Third-party providers are out of scope (decision 0008). */
const PROVIDERS = ["aws", "gcp", "azure"] as const;
type EnvProvider = (typeof PROVIDERS)[number];

/** Environment variables, as `process.env` holds them. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** One key read from the environment, before validation. */
interface EnvKey {
  name: string;
  userConfig: KmsKeyUserConfig;
}

/** A configuration variable standing for an environment variable, so errors and display ids show its name. */
function variable(name: string): ConfigurationVariable {
  return { _type: "ConfigurationVariable", name };
}

/** Splits a comma-separated variable, trimming entries and dropping blank ones. */
function entries(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Reads a list variable, then its single-value fallback, as Foundry does. Both are split on
 * commas; entries are trimmed and blank ones dropped. A repeated entry is an error.
 *
 * @returns Each entry with the name it is shown under: `AWS_KMS_KEY_ID` for a single value,
 * `AWS_KMS_KEY_IDS[1]` for a list entry.
 */
function keyIds(
  provider: EnvProvider,
  env: Environment,
  list: string,
  single: string,
): Array<[string, string]> {
  // An empty variable counts as unset, as `NAME=` does elsewhere in shells and CI.
  const listSet = (env[list]?.trim() ?? "") !== "";
  const variableName = listSet ? list : single;
  const ids = entries(env[variableName] ?? "");
  if (ids.length === 0) {
    throw listSet
      ? catalogError(ERRORS.kmsOptionListEmpty, { provider, list })
      : catalogError(ERRORS.kmsOptionNotSet, { provider, single, list });
  }
  const named = ids.map((id, index): [string, string] => [
    variableName === single && ids.length === 1 ? single : `${variableName}[${index}]`,
    id,
  ]);
  const seen = new Map<string, string>();
  for (const [name, id] of named) {
    const first = seen.get(id);
    if (first !== undefined) {
      throw catalogError(ERRORS.kmsOptionRepeated, { provider, name, first });
    }
    seen.set(id, name);
  }
  return named;
}

/**
 * Builds one provider's keys from Foundry's environment variables.
 *
 * @returns The keys, and the values their variables stand for.
 */
function envKeys(
  provider: EnvProvider,
  env: Environment,
): { keys: EnvKey[]; values: Map<string, string> } {
  const values = new Map<string, string>();
  const read = (name: string): ConfigurationVariable => {
    const value = env[name]?.trim();
    if (value === undefined || value === "") {
      throw catalogError(ERRORS.kmsOptionVariableNotSet, { provider, name });
    }
    values.set(name, value);
    return variable(name);
  };
  if (provider === "gcp") {
    const userConfig: GcpKmsKeyComponentsUserConfig = {
      provider: "gcp",
      projectId: read("GCP_PROJECT_ID"),
      location: read("GCP_LOCATION"),
      keyRing: read("GCP_KEY_RING"),
      keyName: read("GCP_KEY_NAME"),
      keyVersion: read("GCP_KEY_VERSION"),
    };
    return { keys: [{ name: "GCP_KEY_*", userConfig }], values };
  }
  const ids =
    provider === "aws"
      ? keyIds(provider, env, "AWS_KMS_KEY_IDS", "AWS_KMS_KEY_ID")
      : keyIds(provider, env, "AZURE_KEY_VAULT_KEY_IDS", "AZURE_KEY_VAULT_KEY_ID");
  const keys = ids.map(([name, value]): EnvKey => {
    values.set(name, value);
    const userConfig: AwsKmsKeyUserConfig | AzureKmsKeyIdUserConfig =
      provider === "aws"
        ? { provider, keyId: variable(name) }
        : { provider, keyId: variable(name) };
    return { name, userConfig };
  });
  return { keys, values };
}

/** Resolves the stand-in variables to the values `envKeys` read; nothing else is read. */
function resolverFor(values: Map<string, string>): ConfigurationVariableResolver {
  return (valueOrVariable) => {
    const get = async (): Promise<string> => {
      if (typeof valueOrVariable === "string") {
        return valueOrVariable;
      }
      const value = values.get(valueOrVariable.name);
      if (value === undefined) {
        throw internalError(ERRORS.kmsOptionNoValue, { name: valueOrVariable.name });
      }
      return value;
    };
    const resolved: ResolvedConfigurationVariable = {
      _type: "ResolvedConfigurationVariable",
      format: "{}",
      get,
      getUrl: get,
      getBigInt: async () => BigInt(await get()),
      getHexString: get,
    };
    return resolved;
  };
}

/**
 * Parses the `--kms` value: a comma-separated list of built-in provider ids. Blank entries are
 * ignored; an empty list, an unknown id or a repeated id is an error.
 *
 * @param option - The option's value.
 * @returns The provider ids, in order.
 */
export function parseKmsOption(option: string): EnvProvider[] {
  const ids = option
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  if (ids.length === 0) {
    throw catalogError(ERRORS.kmsOptionEmpty, {});
  }
  const seen = new Set<EnvProvider>();
  for (const id of ids) {
    const provider = PROVIDERS.find((candidate) => candidate === id);
    if (provider === undefined) {
      const meant = builtinLookalike(id);
      throw meant === undefined
        ? catalogError(ERRORS.kmsOptionUnknown, { provider: id })
        : catalogError(ERRORS.kmsOptionUnknownSuggested, { provider: id, suggestion: meant });
    }
    if (seen.has(provider)) {
      throw catalogError(ERRORS.kmsOptionListedTwice, { provider });
    }
    seen.add(provider);
  }
  return [...seen];
}

/**
 * Builds the keys `--kms` selects from Foundry's environment variables, with the same checks as
 * keys from the config. Values are read from `env` and checked now, so a mistake fails before any
 * task runs; nothing else is read and no SDK is loaded.
 *
 * @param option - The `--kms` value.
 * @param env - The environment, normally `process.env`.
 * @param defaults - The resolved `kms.defaults`, which these keys inherit.
 * @returns The resolved keys, in the order of `--kms` and of each list variable.
 */
export async function keysFromKmsOption(
  option: string,
  env: Environment,
  defaults: KmsConfig["defaults"],
): Promise<KmsKeyConfig[]> {
  const resolved: KmsKeyConfig[] = [];
  for (const provider of parseKmsOption(option)) {
    const { keys, values } = envKeys(provider, env);
    const resolveVariable = resolverFor(values);
    for (const key of keys) {
      const resolvedKey = resolveKey(key.userConfig, {
        name: key.name,
        path: `--kms ${provider}`,
        resolveVariable,
        defaults,
      });
      // Read and check the value now, with the same rules as a value from the config.
      // Narrowed by field, not by provider: third-party providers can add key types to the union.
      if ("keyVersionName" in resolvedKey) {
        await resolvedKey.keyVersionName.get();
      } else if ("keyId" in resolvedKey) {
        await resolvedKey.keyId.get();
      }
      resolved.push(resolvedKey);
    }
  }
  return resolved;
}
