# hardhat-kms

> In development. Not published to npm yet.

A Hardhat 3 plugin that signs transactions, messages and typed data with secp256k1 keys held in **AWS KMS**, **Google Cloud KMS** and **Azure Key Vault**. The private key never leaves the KMS.

The plugin works at the JSON-RPC layer, so viem, ethers, Ignition and plain scripts use KMS keys like any other account. Every signature is checked locally before it is used: it must recover to the configured account's address.

## Planned usage

Each cloud has its own package, so signing with AWS KMS takes the core and `hardhat-kms-aws`:

```sh
npm install --save-dev hardhat-kms hardhat-kms-aws
```

Keys are declared once under `kms.keys` and attached to networks by name. Credentials come from each cloud SDK's default chain, not from the config.

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAws from "hardhat-kms-aws";

export default defineConfig({
  plugins: [hardhatKmsAws],
  kms: {
    keys: {
      deployer: { provider: "aws", keyId: "alias/deployer", address: "0x…" },
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

`hardhat-kms-aws` loads `hardhat-kms` itself. For complete projects that deploy and call a contract from a KMS account with viem, ethers or Ignition, see [examples/](examples/README.md). Azure Key Vault and Managed HSM keys need `hardhat-kms-azure` instead ([setup guide](docs/user/guides/azure-key-vault-setup.md)). The Google Cloud package is planned ([#29](https://github.com/aelmanaa/hardhat-kms/issues/29)). See the [configuration reference](docs/user/reference/configuration.md) for every option.

## Docs

- All docs, for users and contributors: [docs/README.md](docs/README.md)
- For coding agents: [AGENTS.md](AGENTS.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: [SECURITY.md](SECURITY.md)

## License

MIT
