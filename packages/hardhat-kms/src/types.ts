/**
 * Public types of hardhat-kms: the `kms` config section, key configs and their resolved forms.
 *
 * Third-party providers add their key config type by augmenting {@link KmsProviderUserConfigs}.
 */

import type { ConfigurationVariable } from "hardhat/types/config";
import type { HookContext } from "hardhat/types/hooks";

import type { KmsKeyAdapter } from "./internal/signer/types.ts";

/** A value that can be written literally or read from a configuration variable. */
export type KmsIdentifierUserConfig = string | ConfigurationVariable;

/** Settings shared by every key, whatever its provider. */
export interface KmsKeyCommonUserConfig {
  /**
   * The address the key must derive to. Optional, recommended: the plugin then skips a KMS call to
   * learn the address, and refuses to sign if the key turns out to be different.
   */
  address?: string;
  /** Time budget for each KMS call for this key, in milliseconds. Overrides `kms.defaults.timeoutMs`. */
  timeoutMs?: number;
  /**
   * Time budget for providers with an asynchronous approval step, in milliseconds. Overrides
   * `kms.defaults.approvalTimeoutMs`.
   */
  approvalTimeoutMs?: number;
}

/** An AWS KMS key. */
export interface AwsKmsKeyUserConfig extends KmsKeyCommonUserConfig {
  provider: "aws";
  /** A key id, key ARN, alias name (`alias/...`) or alias ARN. */
  keyId: KmsIdentifierUserConfig;
  /** AWS region. A region inside an ARN takes precedence and must not conflict with this one. */
  region?: string;
  /** Named profile from the AWS shared config files. */
  profile?: string;
  /** Custom KMS endpoint URL, for example a LocalStack instance. */
  endpoint?: string;
}

/** A Google Cloud KMS key version, given as its full resource name. */
export interface GcpKmsKeyVersionNameUserConfig extends KmsKeyCommonUserConfig {
  provider: "gcp";
  /** `projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>/cryptoKeyVersions/<v>`. */
  keyVersionName: KmsIdentifierUserConfig;
}

/** A Google Cloud KMS key version, given as its components. */
export interface GcpKmsKeyComponentsUserConfig extends KmsKeyCommonUserConfig {
  provider: "gcp";
  projectId: KmsIdentifierUserConfig;
  location: KmsIdentifierUserConfig;
  keyRing: KmsIdentifierUserConfig;
  keyName: KmsIdentifierUserConfig;
  /** The key version. Always required: the plugin never picks a version for you. */
  keyVersion: KmsIdentifierUserConfig | number;
}

/** A Google Cloud KMS key version. */
export type GcpKmsKeyUserConfig = GcpKmsKeyVersionNameUserConfig | GcpKmsKeyComponentsUserConfig;

/** An Azure Key Vault or Managed HSM key, given as its full key identifier URL. */
export interface AzureKmsKeyIdUserConfig extends KmsKeyCommonUserConfig {
  provider: "azure";
  /**
   * `https://<vault>.vault.azure.net/keys/<name>[/<version>]`, or a Managed HSM or sovereign-cloud
   * equivalent. An unversioned key is resolved once and that version is then used.
   */
  keyId: KmsIdentifierUserConfig;
}

/** An Azure Key Vault or Managed HSM key, given as its components. */
export interface AzureKmsKeyComponentsUserConfig extends KmsKeyCommonUserConfig {
  provider: "azure";
  /** `https://<vault>.vault.azure.net`, or a Managed HSM or sovereign-cloud equivalent. */
  vaultUrl: KmsIdentifierUserConfig;
  keyName: KmsIdentifierUserConfig;
  keyVersion?: KmsIdentifierUserConfig;
}

/** An Azure Key Vault or Managed HSM key. */
export type AzureKmsKeyUserConfig = AzureKmsKeyIdUserConfig | AzureKmsKeyComponentsUserConfig;

/**
 * Key config types by provider id. Third-party providers augment this interface:
 *
 * ```ts
 * declare module "hardhat-kms/types" {
 *   interface KmsProviderUserConfigs {
 *     myvault: { provider: "myvault"; keyPath: string } & KmsKeyCommonUserConfig;
 *   }
 * }
 * ```
 */
export interface KmsProviderUserConfigs {
  aws: AwsKmsKeyUserConfig;
  gcp: GcpKmsKeyUserConfig;
  azure: AzureKmsKeyUserConfig;
}

/** A key of any registered provider. */
export type KmsKeyUserConfig = KmsProviderUserConfigs[keyof KmsProviderUserConfigs];

/** An entry of a network's `kmsAccounts`: the name of a key in `kms.keys`, or an inline key. */
export type KmsAccountUserConfig = string | KmsKeyUserConfig;

/** The `kms` section of the Hardhat config. */
export interface KmsUserConfig {
  /** Named keys, referenced by name from any network's `kmsAccounts`. */
  keys?: Record<string, KmsKeyUserConfig>;
  defaults?: {
    /** Defaults for AWS keys. */
    aws?: { region?: string };
    /** Default time budget for each KMS call, in milliseconds. Default: 30000. */
    timeoutMs?: number;
    /** Default time budget for providers with an asynchronous approval step, in milliseconds. */
    approvalTimeoutMs?: number;
  };
  /** Allow typed data whose `domain.chainId` differs from the connected chain. Default: `false`. */
  allowCrossChainTypedData?: boolean;
  /** On `edr-simulated` networks only, give each KMS address this balance, in wei. */
  simulatedBalance?: bigint;
}

/**
 * A resolved identifier. `get()` reads its value on demand, trimmed of surrounding whitespace.
 * `display` is safe to print: a value from a configuration variable displays as `<VARIABLE_NAME>`.
 */
export interface KmsIdentifier {
  get(): Promise<string>;
  readonly display: string;
}

/** Resolved settings shared by every key. */
export interface KmsKeyCommonConfig {
  /** The key's name in `kms.keys`, or `<network>.kmsAccounts[<index>]` for an inline key. */
  name: string;
  /** The checksummed address pin, if one was configured. */
  address?: string;
  timeoutMs: number;
  approvalTimeoutMs?: number;
  /**
   * A description of the key that is safe to print, such as `aws:alias/deployer`. It never contains
   * a configuration variable's value.
   */
  displayId: string;
}

/** A resolved AWS KMS key. */
export interface AwsKmsKeyConfig extends KmsKeyCommonConfig {
  provider: "aws";
  keyId: KmsIdentifier;
  /**
   * The first region set among a literal key ARN, the key's `region` and `kms.defaults.aws.region`.
   * When `keyId` comes from a configuration variable and holds an ARN, the ARN's region is used
   * instead, and a conflicting `region` is an error when the key is first used.
   */
  region?: string;
  profile?: string;
  endpoint?: string;
}

/** A resolved Google Cloud KMS key version. */
export interface GcpKmsKeyConfig extends KmsKeyCommonConfig {
  provider: "gcp";
  /** The full key version resource name. */
  keyVersionName: KmsIdentifier;
}

/** A resolved Azure Key Vault or Managed HSM key. */
export interface AzureKmsKeyConfig extends KmsKeyCommonConfig {
  provider: "azure";
  /** The key identifier URL, versioned or not. */
  keyId: KmsIdentifier;
}

/**
 * A resolved key of a third-party provider. The plugin validates only the fields every key shares;
 * the rest of `userConfig` is left to the provider. Configuration variables inside `userConfig`
 * are resolved, as Hardhat does for its own config.
 */
export interface ExternalKmsKeyConfig<Provider extends string = string> extends KmsKeyCommonConfig {
  provider: Provider;
  userConfig: Readonly<Record<string, unknown>>;
}

/**
 * Resolved key config types by provider id. A third-party provider that augments
 * {@link KmsProviderUserConfigs} augments this interface too, usually with
 * `ExternalKmsKeyConfig<"its-id">`, so that resolved keys can be narrowed on `provider`.
 */
export interface KmsProviderConfigs {
  aws: AwsKmsKeyConfig;
  gcp: GcpKmsKeyConfig;
  azure: AzureKmsKeyConfig;
}

/** A resolved key of any registered provider. Narrow it with `key.provider === "aws"`. */
export type KmsKeyConfig = KmsProviderConfigs[keyof KmsProviderConfigs];

/** The resolved `kms` section. */
export interface KmsConfig {
  keys: Record<string, KmsKeyConfig>;
  defaults: {
    aws: { region?: string };
    timeoutMs: number;
    approvalTimeoutMs?: number;
  };
  allowCrossChainTypedData: boolean;
  simulatedBalance?: bigint;
}

export type { KeyDescription, KmsKeyAdapter, SignContext } from "./internal/signer/types.ts";
export type { SignatureOutput } from "./internal/crypto/signature.ts";
export type { TypedData } from "./internal/crypto/digests.ts";

/**
 * The `kms` hook category, which provider plugins use to add their adapters.
 *
 * @experimental The hook may change before 1.0.
 */
export interface KmsHooks {
  /**
   * Builds the adapter for one key. A handler builds adapters for its own provider ids and calls
   * `next` for any other key. The first-party provider packages, such as hardhat-kms-aws, use
   * this hook too. A key that no handler claims fails with an error; for `aws`, `gcp` and `azure`
   * keys, the error names the package to install.
   *
   * The plugin validates only the fields every key shares. A handler validates the rest of an
   * `ExternalKmsKeyConfig`'s `userConfig` itself; configuration variables in it are
   * `ResolvedConfigurationVariable` objects. The plugin rejects an adapter without `describe()`,
   * without a signing method, or without `getPublicKey` or `getAddress` when the key has no
   * `address` pin. It verifies every signature an adapter returns.
   *
   * @param context - The Hardhat runtime, without tasks.
   * @param key - The resolved key.
   * @param next - Passes the key to the next handler.
   * @returns The key's adapter.
   */
  createKeyAdapter(
    context: HookContext,
    key: KmsKeyConfig,
    next: (nextContext: HookContext, nextKey: KmsKeyConfig) => Promise<KmsKeyAdapter>,
  ): Promise<KmsKeyAdapter>;
}

// Provider plugins often import only this module; this brings in the `kms` hook category and
// the config type extensions.
export type * from "./type-extensions.ts";
