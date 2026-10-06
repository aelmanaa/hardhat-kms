[![npm version](https://img.shields.io/npm/v/hardhat-kms)](https://www.npmjs.com/package/hardhat-kms)
[![CI](https://github.com/aelmanaa/hardhat-kms/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/aelmanaa/hardhat-kms/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/aelmanaa/hardhat-kms)](https://github.com/aelmanaa/hardhat-kms/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/hardhat-kms)](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/support.md)

# hardhat-kms

Sign Hardhat 3 transactions, messages and typed data with keys held in **AWS KMS**, **Google Cloud KMS** or **Azure Key Vault**. The private key never leaves the KMS.

> [!NOTE]
> Hardhat 3 only. A community plugin, built in a personal capacity; not affiliated with or endorsed by Nomic Foundation, Amazon Web Services, Google or Microsoft.

- viem, ethers, Ignition and plain scripts use KMS accounts unchanged: the plugin works at the JSON-RPC layer.
- Every signature is recovered locally and must match the configured address before it is used. See the [security model](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/explanation/security-model.md).
- Three clouds, one config: `@hardhat-kms/aws`, `@hardhat-kms/gcp` and `@hardhat-kms/azure`. Credentials come from each cloud SDK's default chain, never from the Hardhat config.
- Foundry-compatible `--kms` option, and `kms` tasks: `accounts`, `address`, `sign`, `sign-tx`, `verify` and `history`, which reads your cloud audit log.
- Legacy, EIP-2930, EIP-1559 and EIP-7702 transactions, EIP-191 and EIP-712 signing, all run on Sepolia in a [live proof](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/live-proof.md) with block ranges and on-chain `ecrecover` checks.
- Releases are published from GitHub Actions with npm provenance; `npm audit signatures` checks them. Report vulnerabilities as [SECURITY.md](https://github.com/aelmanaa/hardhat-kms/blob/main/SECURITY.md) says.

## Install

Each cloud has its own package, and it pulls in the core:

```sh
npm install --save-dev hardhat-kms @hardhat-kms/aws   # or @hardhat-kms/gcp, or @hardhat-kms/azure
```

Peer dependencies, which you install yourself: `hardhat` ^3.18.0 and, if you call `connection.kms.getAccount`, `viem` ^2.55.13. ethers and Ignition projects need no other peer. npm installs peers; yarn does not. These packages are newer than most AI training data: check npm for the current version.

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

Run `npx hardhat kms accounts` to see the key's address, then pin it in the key's config with `address`. Next: a first deploy with [AWS KMS](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/tutorials/first-deploy-aws.md), [Google Cloud KMS](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/tutorials/first-deploy-gcp.md) or [Azure Key Vault](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/tutorials/first-deploy-azure.md), the [security model](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/explanation/security-model.md), the [comparison with Foundry](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/explanation/foundry-comparison.md), the [configuration reference](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/configuration.md) and [all docs](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/README.md).

## Official packages

The official packages are `hardhat-kms` and the packages under the `@hardhat-kms` npm scope. A package with any other name, such as `hardhat-kms-aws`, does not come from this project.

## Verify a release

Every release is published by GitHub Actions with npm provenance. `npm audit signatures` in your project checks that the installed packages carry a valid registry signature and provenance attestation. [SECURITY.md](https://github.com/aelmanaa/hardhat-kms/blob/main/SECURITY.md) names the scope and the reporting channel.

## Tasks and the `--kms` option

The `kms` tasks run as `npx hardhat kms <task>`. A task takes a key by the name it has in `kms.keys` and prints its result alone on standard output, so a script can capture it. The [tasks reference](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/tasks.md) has every option.

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

`--kms aws`, `--kms gcp` and `--kms azure` read keys from Foundry's environment variables, such as `AWS_KMS_KEY_ID`, without a config entry, so a Foundry project keeps its variables. [Migrate from Foundry](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/migrate-from-foundry.md) shows the mapping.

## How the plugin changes Hardhat

- A `kms` section in the config (`kms.keys`, `kms.defaults`, `kms.audit`) and a `kmsAccounts` list on each network, validated when the config loads.
- A network hook that handles `eth_accounts`, `eth_sendTransaction`, `eth_signTransaction`, `personal_sign`, `eth_sign` and `eth_signTypedData_v4` for KMS accounts and passes every other request through.
- The `kms` task namespace, listed by `npx hardhat kms`.
- The `--kms` global option.

[How hardhat-kms works](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/explanation/how-it-works.md) follows one transaction through the hook, the KMS and the node.

## Library accounts

`connection.kms.getAccount` returns a viem account for a KMS key, for viem's `signAuthorization`, smart-account owners and scripts. It needs viem 2.55.13 or later. An older viem is refused before any KMS call; the [library accounts reference](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/library-accounts.md) explains the floor and what each package manager installs.

## Support

Which Node.js versions the published packages run on, when a line is dropped and what an older Node.js does: [Support](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/support.md).

## Docs

- All docs, for users and contributors: [docs/README.md](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/README.md)
- For coding agents: [AGENTS.md](https://github.com/aelmanaa/hardhat-kms/blob/main/AGENTS.md)
- Contributing: [CONTRIBUTING.md](https://github.com/aelmanaa/hardhat-kms/blob/main/CONTRIBUTING.md)
- Security reports: [SECURITY.md](https://github.com/aelmanaa/hardhat-kms/blob/main/SECURITY.md)

## License

MIT
