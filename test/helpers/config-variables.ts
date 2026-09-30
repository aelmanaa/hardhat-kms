import type {
  ConfigurationVariable,
  ConfigurationVariableResolver,
  ResolvedConfigurationVariable,
} from "hardhat/types/config";

/**
 * A configuration variable resolver backed by a plain object, for unit tests.
 *
 * @param values - Variable values by name.
 * @returns The resolver.
 */
export function fakeResolver(values: Record<string, string>): ConfigurationVariableResolver {
  return (variable: ConfigurationVariable | string): ResolvedConfigurationVariable => {
    const get = async (): Promise<string> => {
      if (typeof variable === "string") {
        return variable;
      }
      const value = values[variable.name];
      if (value === undefined) {
        throw new Error(`Missing configuration variable ${variable.name}`);
      }
      return value;
    };
    return {
      _type: "ResolvedConfigurationVariable",
      format: "{}",
      get,
      getUrl: get,
      getBigInt: async () => BigInt(await get()),
      getHexString: get,
    };
  };
}
