[![npm version](https://img.shields.io/npm/v/hardhat-kms)](https://www.npmjs.com/package/hardhat-kms)
[![CI](https://github.com/aelmanaa/hardhat-kms/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/aelmanaa/hardhat-kms/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/aelmanaa/hardhat-kms)](LICENSE)
[![node](https://img.shields.io/node/v/hardhat-kms)](docs/user/reference/support.md)

# hardhat-kms

Sign Hardhat 3 transactions, messages and typed data with keys held in **AWS KMS**, **Google Cloud KMS** or **Azure Key Vault**. The private key never leaves the KMS.

Hardhat 3 only. A community plugin, built in a personal capacity; not affiliated with or endorsed by Nomic Foundation, Amazon Web Services, Google or Microsoft.

- viem, ethers, Ignition and plain scripts use KMS accounts unchanged: the plugin works at the JSON-RPC layer.
- Every signature is recovered locally and checked against the key's address before it is used. An optional `address` pin also refuses a key that derives to another address. See the [security model](docs/user/explanation/security-model.md).
- Install the provider package for each cloud you use, and configure its keys under `kms.keys`. No credentials go in the Hardhat config: AWS and Google Cloud keys use their SDK's credential discovery, and Azure keys use the plugin's own credential chain.
- Eight [`kms` tasks](docs/user/reference/tasks.md), from `accounts` to `history`, which reads your cloud audit log, and a `--kms` option that reads Foundry's key variables.
- Legacy, EIP-2930, EIP-1559 and EIP-7702 transactions, EIP-191 and EIP-712 signing, all run on Sepolia in a [live proof](docs/live-proof.md) with block ranges and on-chain `ecrecover` checks.

## Release status

0.9.0 is the release candidate for 1.0.0; install it to test. Until 1.0.0 is published, use it with test keys on testnets. The packages support Hardhat ^3.18.0 and Node.js 22.13.0 or later. [Release channels and versioning](docs/user/explanation/versioning.md) says what a version promises.

## Install

In a Hardhat 3 project (`npx hardhat --init` creates one), install the core, `hardhat-kms`, with the provider package for your cloud: `@hardhat-kms/aws` for AWS KMS, `@hardhat-kms/gcp` for Google Cloud KMS, `@hardhat-kms/azure` for Azure Key Vault or Managed HSM. All hardhat-kms packages in a project have the same version.

```sh
npm install --save-dev "hardhat@^3.18.0" hardhat-kms @hardhat-kms/aws
```

The command names every required peer dependency, so the same list works with yarn, which does not install peers. `connection.kms.getAccount` also needs `viem` ^2.55.13; ethers and Ignition projects can skip it.

[Install hardhat-kms](docs/user/guides/install-before-release.md) gives the pnpm and Yarn commands, the settings each package manager needs, and the check that the plugin is registered.

## Configure a key

This `hardhat.config.ts` attaches one AWS KMS key to Sepolia:

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
      chainId: 11155111,
      kmsAccounts: ["deployer"],
    },
  },
});
```

- `@hardhat-kms/aws` loads the `hardhat-kms` plugin itself, so `plugins` lists only the provider.
- The key must be an asymmetric `ECC_SECG_P256K1` key with key usage `SIGN_VERIFY`. Its region comes from `AWS_REGION` or your AWS profile; set `region` on the key to choose another.
- With `chainId` set, the plugin refuses a transaction when the node at `SEPOLIA_RPC_URL` reports another chain, before any KMS call.

## Check the key

1. List the key and its address. This reads the public key, so it needs only read access to the key:

   ```sh
   npx hardhat kms accounts
   ```

   Below the table, it prints the pin to add for each key that has none, such as `kms.keys.deployer: address: "0x…",`.

2. Add that `address` to the key's entry, for example `deployer: { provider: "aws", keyId: "alias/deployer", address: "0x…" }`. The pin is optional. Without it, the plugin still checks every signature against the address it derives from the key's public key. With it, the plugin also refuses to sign when the key id comes to name a different key, such as after an alias moves.

3. Check that your credentials may sign:

   ```sh
   npx hardhat kms accounts --check-sign
   ```

   Success shows `matches` in the `PIN` column and `ok` in the `SIGN` column. It proves that your credentials may sign with the key and that the signature recovers to the pinned address. The key signs a random message, not a transaction, so this needs no network and no funds. A `FAILED` row prints the reason under it, such as a missing sign permission.

## Next steps

- Create a key and grant access: set up [AWS KMS](docs/user/guides/aws-kms-setup.md), [Google Cloud KMS](docs/user/guides/gcp-kms-setup.md) or [Azure Key Vault](docs/user/guides/azure-key-vault-setup.md).
- Deploy a first contract on Sepolia: the tutorial for [AWS KMS](docs/user/tutorials/first-deploy-aws.md), [Google Cloud KMS](docs/user/tutorials/first-deploy-gcp.md) or [Azure Key Vault](docs/user/tutorials/first-deploy-azure.md).
- Add keys, providers or networks: the [configuration reference](docs/user/reference/configuration.md) and [Use several keys across networks](docs/user/guides/multiple-keys.md).
- Use viem, ethers or Ignition: runnable [examples](examples/README.md), [Deploy with Hardhat Ignition](docs/user/guides/deploy-with-ignition.md), and [library accounts](docs/user/reference/library-accounts.md) for a viem account from `connection.kms.getAccount`.
- Move from Foundry: [Migrate from Foundry](docs/user/guides/migrate-from-foundry.md) and the [comparison with Foundry](docs/user/explanation/foundry-comparison.md).
- Choose where the key lives: a KMS key compared with [a private key in .env](docs/user/explanation/kms-or-env-key.md), [a Ledger](docs/user/explanation/kms-or-ledger.md) and [other KMS signers](docs/user/explanation/other-kms-signers.md).
- See what the plugin changes in Hardhat: [How hardhat-kms works](docs/user/explanation/how-it-works.md).
- Browse [all docs](docs/README.md).

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

`--kms aws`, `--kms gcp` and `--kms azure` read keys from Foundry's environment variables, such as `AWS_KMS_KEY_ID`, so a Foundry project keeps its variables. The option replaces the key's entry in `kms.keys`, not the provider package: install it and list it in `plugins` as above. [Migrate from Foundry](docs/user/guides/migrate-from-foundry.md) shows the mapping.

## Verify a release

Each release is built by a GitHub Actions run of this repository from a signed `v<version>` tag and published with npm provenance, which ties each tarball to that run and commit. In your project, run:

```sh
npm audit signatures
```

The check passes when the command exits with code 0 and its verified attestations include every hardhat-kms package you installed. Otherwise, do not use that version, and report it as [SECURITY.md](SECURITY.md) says. [Verify a release](docs/user/guides/verify-a-release.md) lists the attested packages, reads the provenance, checks the tag's signature and compares the tarball with the repository.

## Security

The official packages are `hardhat-kms` and the packages under the `@hardhat-kms` npm scope. A package with any other name, such as `hardhat-kms-aws`, does not come from this project. The [security model](docs/user/explanation/security-model.md) says what the plugin protects against and what it does not. Report vulnerabilities privately as [SECURITY.md](SECURITY.md) says.

## Support

[Support](docs/user/reference/support.md) lists the Node.js versions the packages run on and where to ask a question. [Release channels and versioning](docs/user/explanation/versioning.md) covers the `latest` and `beta` tags, the Hardhat and viem ranges, and security fixes for a previous major.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, commands and the workflow. Coding agents start at [AGENTS.md](AGENTS.md), and can install the [hardhat-kms skill](skills/hardhat-kms/SKILL.md) with `npx skills add aelmanaa/hardhat-kms`.

## License

MIT
