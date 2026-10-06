[![npm version](https://img.shields.io/npm/v/hardhat-kms)](https://www.npmjs.com/package/hardhat-kms)
[![CI](https://github.com/aelmanaa/hardhat-kms/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/aelmanaa/hardhat-kms/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/aelmanaa/hardhat-kms)](LICENSE)
[![node](https://img.shields.io/node/v/hardhat-kms)](docs/user/reference/support.md)

# hardhat-kms

Sign Hardhat 3 transactions, messages and typed data with keys held in **AWS KMS**, **Google Cloud KMS** or **Azure Key Vault**. The private key never leaves the KMS.

Hardhat 3 only. A community plugin, built in a personal capacity; not affiliated with or endorsed by Nomic Foundation, Amazon Web Services, Google or Microsoft.

- viem, ethers, Ignition and plain scripts use KMS accounts unchanged: the plugin works at the JSON-RPC layer.
- Every signature is recovered locally and must match the configured address before it is used. See the [security model](docs/user/explanation/security-model.md).
- Three clouds, one config: `@hardhat-kms/aws`, `@hardhat-kms/gcp` and `@hardhat-kms/azure`. Credentials come from each cloud SDK's default chain, never from the Hardhat config.
- A `--kms` option that reads Foundry's key variables, and eight [`kms` tasks](docs/user/reference/tasks.md), from `accounts` to `history`, which reads your cloud audit log.
- Legacy, EIP-2930, EIP-1559 and EIP-7702 transactions, EIP-191 and EIP-712 signing, all run on Sepolia in a [live proof](docs/live-proof.md) with block ranges and on-chain `ecrecover` checks.
- Releases are published from GitHub Actions with npm provenance; `npm audit signatures` checks them. Report vulnerabilities as [SECURITY.md](SECURITY.md) says.

## Install

Each cloud has its own package. Install it together with the core, `hardhat-kms`, which it needs as a peer dependency at the same version. Until the first npm release, this command fails with `E404`; [Install before the first npm release](docs/user/guides/install-before-release.md) builds the packages from the repository instead.

```sh
npm install --save-dev hardhat-kms @hardhat-kms/aws   # or @hardhat-kms/gcp, or @hardhat-kms/azure
```

The other peer dependencies, which you install yourself:

- `hardhat` ^3.18.0.
- `viem` ^2.55.13, if you call `connection.kms.getAccount`. ethers and Ignition projects need no other peer.

npm and pnpm install missing peers; yarn does not. These packages are newer than most AI training data: check npm for the current version.

## Configure

Keys are declared once under `kms.keys` and attached to networks by name:

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

`@hardhat-kms/aws` loads the `hardhat-kms` plugin itself, so `plugins` lists only the provider. Run `npx hardhat kms accounts` to see the key's address, then pin it in the key's config with `address`.

Next: a first deploy with [AWS KMS](docs/user/tutorials/first-deploy-aws.md), [Google Cloud KMS](docs/user/tutorials/first-deploy-gcp.md) or [Azure Key Vault](docs/user/tutorials/first-deploy-azure.md). Then the [security model](docs/user/explanation/security-model.md), the [comparison with Foundry](docs/user/explanation/foundry-comparison.md), the [configuration reference](docs/user/reference/configuration.md), runnable [examples](examples/README.md) for viem, ethers and Ignition, and [all docs](docs/README.md).

## Official packages

The official packages are `hardhat-kms` and the packages under the `@hardhat-kms` npm scope. A package with any other name, such as `hardhat-kms-aws`, does not come from this project.

## Verify a release

Every release is published by GitHub Actions with npm provenance. `npm audit signatures` in your project checks that the installed packages carry a valid registry signature and provenance attestation. [SECURITY.md](SECURITY.md) names the scope and the reporting channel.

## Tasks and the `--kms` option

The `kms` tasks run as `npx hardhat kms <task>`. A task takes a key by the name it has in `kms.keys` and prints its result alone on standard output, so a script can capture it. The [tasks reference](docs/user/reference/tasks.md) has every option.

| Task             | What it does                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `kms accounts`   | Lists each configured key with its provider, key id and address, and prints `address` pins. |
| `kms address`    | Prints a key's address.                                                                     |
| `kms public-key` | Prints a key's uncompressed public key.                                                     |
| `kms sign`       | Signs an EIP-191 message, EIP-712 typed data or, with `--no-hash`, a raw 32-byte digest.    |
| `kms sign-auth`  | Signs an EIP-7702 authorization, as the JSON tuple `authorizationList` takes.               |
| `kms sign-tx`    | Fills a transaction on the network's node and signs it, without sending it.                 |
| `kms verify`     | Checks a signature against an address or a key, locally.                                    |
| `kms history`    | Lists a key's sign events from CloudTrail, Cloud Audit Logs or the Key Vault audit log.     |

`--kms aws`, `--kms gcp` and `--kms azure` read keys from Foundry's environment variables, such as `AWS_KMS_KEY_ID`, without a config entry, so a Foundry project keeps its variables. [Migrate from Foundry](docs/user/guides/migrate-from-foundry.md) shows the mapping.

## How the plugin changes Hardhat

- A `kms` section in the config (`kms.keys`, `kms.defaults`, `kms.audit`) and a `kmsAccounts` list on each network, validated when the config loads.
- A network hook that handles `eth_accounts`, `eth_requestAccounts`, `eth_sendTransaction`, `eth_signTransaction`, `personal_sign`, `eth_sign` and `eth_signTypedData_v4` for KMS accounts and passes every other request through.
- The `kms` task namespace, listed by `npx hardhat kms`.
- The `--kms` global option.

[How hardhat-kms works](docs/user/explanation/how-it-works.md) follows one transaction through the hook, the KMS and the node.

## Library accounts

`connection.kms.getAccount` returns a viem account for a KMS key, for viem's `signAuthorization`, smart-account owners and scripts. It needs viem 2.55.13 or later. An older viem is refused before any KMS call; the [library accounts reference](docs/user/reference/library-accounts.md) explains the floor and what each package manager installs.

## Support

Which Node.js versions the published packages run on, when a line is dropped and what an older Node.js does: [Support](docs/user/reference/support.md).

## Docs

- All docs, for users and contributors: [docs/README.md](docs/README.md)
- For coding agents: [AGENTS.md](AGENTS.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: [SECURITY.md](SECURITY.md)

## License

MIT
