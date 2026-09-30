import type {
  KmsAccountUserConfig,
  KmsConfig,
  KmsHooks,
  KmsKeyConfig,
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
