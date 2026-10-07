# @hardhat-kms/azure

Works with Azure Key Vault and Azure Key Vault Managed HSM. Not affiliated with or endorsed by Microsoft.

The Azure Key Vault provider for [hardhat-kms](https://github.com/aelmanaa/hardhat-kms): Hardhat 3 signs transactions, messages and typed data with secp256k1 keys held in Azure Key Vault or Azure Managed HSM. The private key never leaves the vault. The package depends on `@azure/keyvault-keys` and `@azure/identity`, so there is no SDK to install separately.

0.9.0 is the release candidate for 1.0.0; install it to test. Until 1.0.0 is published, use it with test keys on testnets.

## Key type

An `EC` or `EC-HSM` key on the `P-256K` curve, with `sign` among its permitted operations.

## Install

```sh
npm install --save-dev "hardhat@^3.18.0" hardhat-kms @hardhat-kms/azure
```

`@hardhat-kms/azure` needs `hardhat-kms` at the same version. The packages run on Node.js 22.13.0 or later ([Support](https://aelmanaa.github.io/hardhat-kms/user/reference/support)).

## Configure

Add `@hardhat-kms/azure` to `plugins`. It loads `hardhat-kms` itself.

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAzure from "@hardhat-kms/azure";

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
      chainId: 11155111,
      kmsAccounts: ["deployer"],
    },
  },
});
```

A `keyId` with a version names one key version. Without the version, it follows the key's current version, which a rotation changes. The [configuration reference](https://aelmanaa.github.io/hardhat-kms/user/reference/configuration) lists every option.

## Check the key

1. Run `npx hardhat kms accounts`. It reads the key's public key and prints its address, and below the table the `address` pin to add.
2. Add the pin to the key's entry, for example `deployer: { provider: "azure", keyId: "https://my-vault.vault.azure.net/keys/deployer/…", address: "0x…" }`. The pin is optional. Without it, the plugin still checks every signature against the address it derives from the key's public key. With it, the plugin also refuses to sign when the key id comes to name a different key.
3. Run `npx hardhat kms accounts --check-sign`. `ok` in the `SIGN` column proves that your credentials may sign with the key, not only read it. The key signs a random message, not a transaction, so this needs no network and no funds.

## Credentials and permissions

The plugin builds its own credential chain and uses the first source that returns a token: a service principal in the environment, workload identity, `az login` or `azd auth login`, then a managed identity. On a laptop, `az login` is enough. No credentials go in the Hardhat config. The identity needs `get` and `sign` on the key: a custom role with only the `Microsoft.KeyVault/vaults/keys/read` and `Microsoft.KeyVault/vaults/keys/sign/action` data actions, or the broader Key Vault Crypto User role.

- [Set up an Azure Key Vault key](https://aelmanaa.github.io/hardhat-kms/user/guides/azure-key-vault-setup): create the key, grant access, configure Hardhat.
- [Permissions](https://aelmanaa.github.io/hardhat-kms/user/guides/azure-key-vault-setup#2-allow-get-and-sign-and-nothing-else) and [credential sources](https://aelmanaa.github.io/hardhat-kms/user/guides/azure-key-vault-setup#3-sign-in) in detail.
- [Errors](https://aelmanaa.github.io/hardhat-kms/user/guides/azure-key-vault-setup#errors): what each failure means and how to fix it.
- [All docs](https://aelmanaa.github.io/hardhat-kms/).
