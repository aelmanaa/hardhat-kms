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
import { kmsError } from "../errors.ts";
import { resolveKey } from "./resolve.ts";
import { builtinLookalike, keySchema } from "./schema.ts";

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

function fail(provider: string, message: string): never {
  throw kmsError(`--kms ${provider}: ${message}`);
}

/**
 * Reads a list variable, then its single-value fallback, as Foundry does. Entries are trimmed and
 * blank ones dropped.
 *
 * @returns Each entry with the name it is shown under, such as `AWS_KMS_KEY_IDS[1]`.
 */
function keyIds(
  provider: EnvProvider,
  env: Environment,
  list: string,
  single: string,
): Array<[string, string]> {
  const listed = env[list];
  if (listed !== undefined) {
    const entries = listed
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    if (entries.length === 0) {
      fail(provider, `${list} is set but holds no key ids`);
    }
    return entries.map((entry, index) => [`${list}[${index}]`, entry]);
  }
  const value = env[single]?.trim();
  if (value === undefined || value === "") {
    fail(provider, `set ${single}, or ${list} for several keys`);
  }
  return [[single, value]];
}

/**
 * Builds each provider's keys from Foundry's environment variables.
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
      fail(provider, `${name} is not set`);
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

/** Resolves the stand-in variables to the environment values read above; nothing else is read. */
function resolverFor(values: Map<string, string>): ConfigurationVariableResolver {
  return (valueOrVariable) => {
    const get = async (): Promise<string> => {
      if (typeof valueOrVariable === "string") {
        return valueOrVariable;
      }
      const value = values.get(valueOrVariable.name);
      if (value === undefined) {
        throw new Error(`no value for ${valueOrVariable.name}`);
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
 * Parses the `--kms` value: a comma-separated list of built-in provider ids.
 *
 * @param option - The option's value.
 * @returns The provider ids, in order, without duplicates.
 */
export function parseKmsOption(option: string): EnvProvider[] {
  const ids = option
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  if (ids.length === 0) {
    fail("", "expected one or more of aws, gcp and azure, such as --kms aws");
  }
  const seen = new Set<EnvProvider>();
  for (const id of ids) {
    const provider = PROVIDERS.find((candidate) => candidate === id);
    if (provider === undefined) {
      const meant = builtinLookalike(id);
      fail(
        id,
        `unknown provider.${meant === undefined ? "" : ` Did you mean "${meant}"?`} Expected aws, gcp or azure`,
      );
    }
    if (seen.has(provider)) {
      fail(provider, "listed twice");
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
      const parsed = keySchema.safeParse(key.userConfig);
      if (!parsed.success) {
        fail(
          provider,
          `${key.name}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
        );
      }
      const resolvedKey = resolveKey(key.userConfig, {
        name: key.name,
        path: `--kms ${provider}`,
        resolveVariable,
        defaults,
      });
      // Read and check the value now, with the same rules as a value from the config.
      await (resolvedKey.provider === "gcp"
        ? resolvedKey.keyVersionName.get()
        : resolvedKey.keyId.get());
      resolved.push(resolvedKey);
    }
  }
  return resolved;
}
