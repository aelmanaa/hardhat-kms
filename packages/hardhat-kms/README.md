[![npm version](https://img.shields.io/npm/v/hardhat-kms)](https://www.npmjs.com/package/hardhat-kms)
[![CI](https://github.com/aelmanaa/hardhat-kms/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/aelmanaa/hardhat-kms/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/aelmanaa/hardhat-kms)](https://github.com/aelmanaa/hardhat-kms/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/hardhat-kms)](https://aelmanaa.github.io/hardhat-kms/user/reference/support)

# hardhat-kms

Sign Hardhat 3 transactions, messages and typed data with keys held in **AWS KMS**, **Google Cloud KMS** or **Azure Key Vault**. The private key never leaves the KMS.

Hardhat 3 only. A community plugin, built in a personal capacity; not affiliated with or endorsed by Nomic Foundation, Amazon Web Services, Google or Microsoft.

- viem, ethers, Ignition and plain scripts use KMS accounts unchanged: the plugin works at the JSON-RPC layer.
- Every signature is recovered locally and checked against the key's address before it is used. An optional `address` pin also refuses a key that derives to another address. See the [security model](https://aelmanaa.github.io/hardhat-kms/user/explanation/security-model).
- Install the provider package for each cloud you use, and configure its keys under `kms.keys`. No credentials go in the Hardhat config: AWS and Google Cloud keys use their SDK's credential discovery, and Azure keys use the plugin's own credential chain.
- Eight [`kms` tasks](https://aelmanaa.github.io/hardhat-kms/user/reference/tasks), from `accounts` to `history`, which reads your cloud audit log, and a `--kms` option that reads Foundry's key variables.
- Legacy, EIP-2930, EIP-1559 and EIP-7702 transactions, EIP-191 and EIP-712 signing, all run on Sepolia in a [live proof](https://aelmanaa.github.io/hardhat-kms/live-proof) with block ranges and on-chain `ecrecover` checks.

## Release status

0.9.0 is the release candidate for 1.0.0; install it to test. Until 1.0.0 is published, use it with test keys on testnets. The packages support Hardhat ^3.18.0 and Node.js 22.13.0 or later. [Release channels and versioning](https://aelmanaa.github.io/hardhat-kms/user/explanation/versioning) says what a version promises.

## Install

In a Hardhat 3 project (`npx hardhat --init` creates one), install the core, `hardhat-kms`, with the provider package for your cloud: `@hardhat-kms/aws` for AWS KMS, `@hardhat-kms/gcp` for Google Cloud KMS, `@hardhat-kms/azure` for Azure Key Vault or Managed HSM. All hardhat-kms packages in a project have the same version.

```sh
npm install --save-dev "hardhat@^3.18.0" hardhat-kms @hardhat-kms/aws
```

The command names every required peer dependency, so the same list works with yarn, which does not install peers. `connection.kms.getAccount` also needs `viem` ^2.55.13; ethers and Ignition projects can skip it.

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

- Create a key and grant access: set up [AWS KMS](https://aelmanaa.github.io/hardhat-kms/user/guides/aws-kms-setup), [Google Cloud KMS](https://aelmanaa.github.io/hardhat-kms/user/guides/gcp-kms-setup) or [Azure Key Vault](https://aelmanaa.github.io/hardhat-kms/user/guides/azure-key-vault-setup).
- Deploy a first contract on Sepolia: the tutorial for [AWS KMS](https://aelmanaa.github.io/hardhat-kms/user/tutorials/first-deploy-aws), [Google Cloud KMS](https://aelmanaa.github.io/hardhat-kms/user/tutorials/first-deploy-gcp) or [Azure Key Vault](https://aelmanaa.github.io/hardhat-kms/user/tutorials/first-deploy-azure).
- Add keys, providers or networks: the [configuration reference](https://aelmanaa.github.io/hardhat-kms/user/reference/configuration) and [Use several keys across networks](https://aelmanaa.github.io/hardhat-kms/user/guides/multiple-keys).
- Use viem, ethers or Ignition: runnable [examples](https://github.com/aelmanaa/hardhat-kms/blob/main/examples/README.md), [Deploy with Hardhat Ignition](https://aelmanaa.github.io/hardhat-kms/user/guides/deploy-with-ignition), and [library accounts](https://aelmanaa.github.io/hardhat-kms/user/reference/library-accounts) for a viem account from `connection.kms.getAccount`.
- Move from Foundry: [Migrate from Foundry](https://aelmanaa.github.io/hardhat-kms/user/guides/migrate-from-foundry) and the [comparison with Foundry](https://aelmanaa.github.io/hardhat-kms/user/explanation/foundry-comparison).
- Choose where the key lives: a KMS key compared with [a private key in .env](https://aelmanaa.github.io/hardhat-kms/user/explanation/kms-or-env-key), [a Ledger](https://aelmanaa.github.io/hardhat-kms/user/explanation/kms-or-ledger) and [other KMS signers](https://aelmanaa.github.io/hardhat-kms/user/explanation/other-kms-signers).
- See what the plugin changes in Hardhat: [How hardhat-kms works](https://aelmanaa.github.io/hardhat-kms/user/explanation/how-it-works).
- Browse [all docs](https://aelmanaa.github.io/hardhat-kms/).

## Tasks and the `--kms` option

The `kms` tasks run as `npx hardhat kms <task>`. A task takes a key by the name it has in `kms.keys` and prints its result alone on standard output, so a script can capture it. The [tasks reference](https://aelmanaa.github.io/hardhat-kms/user/reference/tasks) has every option.

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

`--kms aws`, `--kms gcp` and `--kms azure` read keys from Foundry's environment variables, such as `AWS_KMS_KEY_ID`, so a Foundry project keeps its variables. The option replaces the key's entry in `kms.keys`, not the provider package: install it and list it in `plugins` as above. [Migrate from Foundry](https://aelmanaa.github.io/hardhat-kms/user/guides/migrate-from-foundry) shows the mapping.

## Verify a release

Each release is built by a GitHub Actions run of this repository from a signed `v<version>` tag and published with npm provenance, which ties each tarball to that run and commit. In your project, run:

```sh
npm audit signatures
```

The check passes when the command exits with code 0 and its verified attestations include every hardhat-kms package you installed. Otherwise, do not use that version, and report it as [SECURITY.md](https://github.com/aelmanaa/hardhat-kms/blob/main/SECURITY.md) says. [Verify a release](https://aelmanaa.github.io/hardhat-kms/user/guides/verify-a-release) lists the attested packages, reads the provenance, checks the tag's signature and compares the tarball with the repository.

## Security

The official packages are `hardhat-kms` and the packages under the `@hardhat-kms` npm scope. A package with any other name, such as `hardhat-kms-aws`, does not come from this project. The [security model](https://aelmanaa.github.io/hardhat-kms/user/explanation/security-model) says what the plugin protects against and what it does not. Report vulnerabilities privately as [SECURITY.md](https://github.com/aelmanaa/hardhat-kms/blob/main/SECURITY.md) says.

## Support

[Support](https://aelmanaa.github.io/hardhat-kms/user/reference/support) lists the Node.js versions the packages run on and where to ask a question. [Release channels and versioning](https://aelmanaa.github.io/hardhat-kms/user/explanation/versioning) covers the `latest` and `beta` tags, the Hardhat and viem ranges, and security fixes for a previous major.

## Contributing

[CONTRIBUTING.md](https://github.com/aelmanaa/hardhat-kms/blob/main/CONTRIBUTING.md) covers setup, commands and the workflow. Coding agents start at [AGENTS.md](https://github.com/aelmanaa/hardhat-kms/blob/main/AGENTS.md), and can install the [hardhat-kms skill](https://github.com/aelmanaa/hardhat-kms/blob/main/skills/hardhat-kms/SKILL.md) with `npx skills add aelmanaa/hardhat-kms`.

## License

MIT
