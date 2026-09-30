# hardhat-kms

> In development. Not published to npm yet.

A Hardhat 3 plugin that signs transactions, messages and typed data with secp256k1 keys held in **AWS KMS**, **Google Cloud KMS** and **Azure Key Vault**. The private key never leaves the KMS.

The plugin works at the JSON-RPC layer, so viem, ethers, Ignition and plain scripts use KMS keys like any other account. Every signature is checked locally before it is used: it must recover to the configured account's address.

## Planned usage

Keys are declared once under `kms.keys` and attached to networks by name. Credentials come from each cloud SDK's default chain, not from the config.

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKms from "hardhat-kms";

export default defineConfig({
  plugins: [hardhatKms],
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

See the [configuration reference](docs/user/reference/configuration.md) for every option.

## Docs

- All docs, for users and contributors: [docs/README.md](docs/README.md)
- For coding agents: [AGENTS.md](AGENTS.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: [SECURITY.md](SECURITY.md)

## License

MIT
