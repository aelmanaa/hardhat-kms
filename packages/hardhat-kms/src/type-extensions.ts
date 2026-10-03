import type {
  KmsAccountUserConfig,
  KmsConfig,
  KmsHooks,
  KmsKeyConfig,
  KmsNetworkConnection,
  KmsUserConfig,
} from "./types.ts";

declare module "hardhat/types/config" {
  export interface HardhatUserConfig {
    kms?: KmsUserConfig;
  }

  export interface HardhatConfig {
    kms: KmsConfig;
  }

  export interface HttpNetworkUserConfig {
    /** Keys this network can sign with: names from `kms.keys`, or inline key objects. */
    kmsAccounts?: KmsAccountUserConfig[];
  }

  export interface EdrNetworkUserConfig {
    /** Keys this network can sign with: names from `kms.keys`, or inline key objects. */
    kmsAccounts?: KmsAccountUserConfig[];
  }

  export interface HttpNetworkConfig {
    kmsAccounts: KmsKeyConfig[];
  }

  export interface EdrNetworkConfig {
    kmsAccounts: KmsKeyConfig[];
  }
}

declare module "hardhat/types/hooks" {
  export interface HardhatHooks {
    kms: KmsHooks;
  }
}

declare module "hardhat/types/global-options" {
  export interface GlobalOptions {
    /**
     * Providers whose keys to load from environment variables, such as `aws,azure`: aws and gcp
     * use Foundry's variables, azure the names proposed in foundry-rs/foundry#17120.
     */
    kms: string | undefined;
  }
}

declare module "hardhat/types/network" {
  export interface NetworkConnection<ChainTypeT extends string = DefaultChainType> {
    /** hardhat-kms's library API: `getAccount` returns a viem account for a KMS account. */
    kms: KmsNetworkConnection;
  }
}
