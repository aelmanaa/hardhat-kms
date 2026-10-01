# hardhat-kms-azure

> In development. Not published to npm yet.

The Azure Key Vault provider for [hardhat-kms](https://github.com/aelmanaa/hardhat-kms): Hardhat 3 signs transactions, messages and typed data with secp256k1 keys held in Azure Key Vault or Azure Managed HSM. The private key never leaves the vault.

It depends on `@azure/keyvault-keys` and `@azure/identity`, so there is no SDK to install separately.

## Install

```sh
npm install --save-dev hardhat-kms hardhat-kms-azure
```

## Usage

Add `hardhat-kms-azure` to `plugins`. It loads `hardhat-kms` itself.

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAzure from "hardhat-kms-azure";

export default defineConfig({
  plugins: [hardhatKmsAzure],
  kms: {
    keys: {
      deployer: {
        provider: "azure",
        keyId: "https://my-vault.vault.azure.net/keys/deployer/0123456789abcdef0123456789abcdef",
      },
    },
  },
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      kmsAccounts: ["deployer"],
    },
  },
});
```

The key must be an `EC` or `EC-HSM` key on the `P-256K` curve, with `sign` among its permitted operations. The identity needs `get` and `sign` on the key, for example through the Key Vault Crypto User role. Credentials come from, in order: a service principal in the environment, workload identity, `az login`, `azd auth login`, then a managed identity (user-assigned with `AZURE_CLIENT_ID`), which gets 10 seconds for a token and 3 seconds for each request.

## Docs

- [Azure Key Vault setup](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/azure-key-vault-setup.md): create a key, grant access, sign in, configure Hardhat
- [Configuration reference](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/configuration.md)
- All docs: [docs/README.md](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/README.md)
