import type { ConfigurationVariable, ResolvedConfigurationVariable } from "hardhat/types/config";

/** `kmsSafe` in the Hardhat config: where `kms safe propose` sends proposals. */
export interface KmsSafeUserConfig {
  /**
   * The Safe Transaction Service API key from developer.safe.global, as
   * `configVariable("SAFE_TRANSACTION_SERVICE_API_KEY")`. Never the key itself: config validation
   * refuses a string. Safe's hosted service needs it; a self-hosted one may not.
   */
  apiKey?: ConfigurationVariable;
  /**
   * The root of a self-hosted Transaction Service per decimal chain id, without `/api`, such as
   * `{ "11155111": "https://safe-transaction.example.com" }`. It replaces Safe's hosted service
   * for that chain.
   */
  services?: Record<string, string>;
  /** How long each request to the service may take, in milliseconds; 30000 by default. */
  timeoutMs?: number;
}

/** `kmsSafe` after Hardhat resolved the config. */
export interface KmsSafeConfig {
  /** The API key's variable, read only when a proposal goes to the service. */
  apiKey: ResolvedConfigurationVariable | undefined;
  /** Self-hosted services by decimal chain id. */
  services: Record<string, string>;
  /** How long each request may take, in milliseconds. */
  timeoutMs: number;
}

declare module "hardhat/types/config" {
  export interface HardhatUserConfig {
    /** Where `kms safe propose` sends proposals (@hardhat-kms/safe). */
    kmsSafe?: KmsSafeUserConfig;
  }
  export interface HardhatConfig {
    /** Where `kms safe propose` sends proposals (@hardhat-kms/safe). */
    kmsSafe: KmsSafeConfig;
  }
}
