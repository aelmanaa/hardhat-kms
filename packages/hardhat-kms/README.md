# hardhat-kms

A community plugin. Not affiliated with or endorsed by Nomic Foundation, Amazon Web Services, Google or Microsoft.

> In development. Not published to npm yet.

A Hardhat 3 plugin that signs transactions, messages and typed data with secp256k1 keys held in **AWS KMS**, **Google Cloud KMS** and **Azure Key Vault**. The private key never leaves the KMS.

The plugin works at the JSON-RPC layer, so viem, ethers, Ignition and plain scripts use KMS keys like any other account. Every signature is checked locally before it is used: it must recover to the configured account's address.

## Usage

This is the core package. Each cloud has its own provider package, so signing with AWS KMS takes the core and `@hardhat-kms/aws`:

```sh
npm install --save-dev hardhat-kms @hardhat-kms/aws
```

Keys are declared once under `kms.keys` and attached to networks by name. Credentials come from each cloud SDK's default chain, not from the config.

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAws from "@hardhat-kms/aws";

export default defineConfig({
  plugins: [hardhatKmsAws],
  kms: {
    keys: {
      deployer: { provider: "aws", keyId: "alias/deployer" },
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

To see the key's address, run `npx hardhat kms accounts`, then pin it in the key's config with `address`. `@hardhat-kms/aws` loads `hardhat-kms` itself. Azure Key Vault and Managed HSM keys need `@hardhat-kms/azure` instead ([setup guide](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/azure-key-vault-setup.md)). Google Cloud KMS keys need `@hardhat-kms/gcp` ([setup guide](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/gcp-kms-setup.md)). See the [configuration reference](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/configuration.md) for every option.

`connection.kms.getAccount`, which returns a viem account for a KMS key, needs viem 2.55.13 or later, a higher floor than hardhat-viem's `^2.47.6`, and refuses an older viem before any KMS call. With viem 2.49.3 and earlier, viem never tells the plugin that a library send failed, so the next send through the plugin waits up to 60 s. With viem 2.50.3 to 2.55.11, viem can report a failure for a send that never got a nonce from the plugin, and a send through the plugin can then take a nonce that another library send still needs. See [library accounts](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/library-accounts.md).

## Official packages

The official packages are `hardhat-kms` and the packages under the `@hardhat-kms` npm scope. A package with any other name, such as `hardhat-kms-aws`, does not come from this project.

## Docs

- All docs, for users and contributors: [docs/README.md](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/README.md)
- For coding agents: [AGENTS.md](https://github.com/aelmanaa/hardhat-kms/blob/main/AGENTS.md)
- Contributing: [CONTRIBUTING.md](https://github.com/aelmanaa/hardhat-kms/blob/main/CONTRIBUTING.md)
- Security reports: [SECURITY.md](https://github.com/aelmanaa/hardhat-kms/blob/main/SECURITY.md)

## License

MIT
