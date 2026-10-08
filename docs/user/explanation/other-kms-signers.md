---
title: Compared with other KMS signers
description: "hardhat-kms compared with the Hardhat 2 hardhat-kms-signer packages and their forks: last release, Hardhat major, cloud, and how each plugs in."
---

# Compared with other KMS signers

Audience: users who searched for a Hardhat KMS signer, found one of the `hardhat-kms-signer` packages, and want to know how it differs from hardhat-kms. Assumes you know what a Hardhat plugin is; no knowledge of either codebase.

Every fact below about another project was checked on 2026-10-07, on the npm registry (`npm view <package>`), in the published tarball (`npm pack <package>`) and in the package's repository. Later releases may change them.

## The packages

Searches of the npm registry on 2026-10-07 for "hardhat-kms", "hardhat kms", "hardhat-kms-signer", "hardhat signer kms", "hardhat gcp kms" and "hardhat azure key vault" returned seven Hardhat plugins that sign with a cloud KMS key. All seven target Hardhat 2:

| Package                                                                                                                          | Cloud        | Last release           | Hardhat range in `package.json` | Repository                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| [`@rumblefishdev/hardhat-kms-signer`](https://www.npmjs.com/package/@rumblefishdev/hardhat-kms-signer)                           | AWS          | 2.0.0, 2024-10-21      | `^2.12.3` (dependency)          | [rumblefishdev/hardhat-kms-signer](https://github.com/rumblefishdev/hardhat-kms-signer)     |
| [`@white-matrix/hardhat-kms-signer`](https://www.npmjs.com/package/@white-matrix/hardhat-kms-signer)                             | AWS          | 0.1.1, 2022-03-10      | `^2.6.0` (peer)                 | [WhiteMatrixTech/hardhat-kms-signer](https://github.com/WhiteMatrixTech/hardhat-kms-signer) |
| [`hardhat-signer-kms`](https://www.npmjs.com/package/hardhat-signer-kms)                                                         | AWS          | 1.3.0, 2024-10-08      | `^2.12.3` (development only)    | [BonneVoyager/hardhat-signer-kms](https://github.com/BonneVoyager/hardhat-signer-kms)       |
| [`@adisakboonmark/hardhat-kms-signer`](https://www.npmjs.com/package/@adisakboonmark/hardhat-kms-signer)                         | AWS          | 0.1.1-beta, 2025-02-09 | `^2.12.3` (development only)    | [ADISAKBOONMARK/hardhat-kms-signer](https://github.com/ADISAKBOONMARK/hardhat-kms-signer)   |
| [`@microverse-dev/hardhat-kms-signer`](https://www.npmjs.com/package/@microverse-dev/hardhat-kms-signer)                         | Google Cloud | 1.0.1, 2023-08-30      | `2.12.0` (peer)                 | [microverse-dev/hardhat-kms-signer](https://github.com/microverse-dev/hardhat-kms-signer)   |
| [`@conduitxyz/hardhat-gcp-kms-signer`](https://www.npmjs.com/package/@conduitxyz/hardhat-gcp-kms-signer)                         | Google Cloud | 1.1.6, 2023-03-23      | `2.9.6` (development only)      | [conduitxyz/hardhat-gcp-kms-signer](https://github.com/conduitxyz/hardhat-gcp-kms-signer)   |
| [`@cuonghx.gu-tech/hardhat-gcp-kms-signer-plugin`](https://www.npmjs.com/package/@cuonghx.gu-tech/hardhat-gcp-kms-signer-plugin) | Google Cloud | 0.9.3, 2024-05-15      | `^2.21.0` (development only)    | [cuonghx-dev/evm-kms-signer](https://github.com/cuonghx-dev/evm-kms-signer)                 |

Table notes:

- Cloud: the cloud whose KMS the package signs with, from its dependencies and its config field.
- Last release: the latest version on npm and its publish date, from `npm view <package> time`.
- Hardhat range: where the package's `package.json` names `hardhat`. "Development only" means it is only in `devDependencies`, so npm does not check it against your project.
- Forks: on GitHub, `WhiteMatrixTech/hardhat-kms-signer` and `BonneVoyager/hardhat-signer-kms` are forks of `rumblefishdev/hardhat-kms-signer`. `ADISAKBOONMARK/hardhat-kms-signer` is a fork of `indiigo-consulting/hardhat-kms-signer`, itself a fork of the rumblefishdev repository.
- Repository: the package's npm metadata names `0xcuonghx/ethers-kms-signer` for `@cuonghx.gu-tech/hardhat-gcp-kms-signer-plugin`; GitHub redirects it to `cuonghx-dev/evm-kms-signer`. Since 2026-10-03 the default branch of that repository holds `@cuonghx/evm-kms-signer`, a signer library for viem and ethers, and no Hardhat plugin.
- None of the seven repositories is archived, and none of the packages is marked deprecated on npm.

The searches found no Hardhat 3 KMS signer and no Hardhat plugin for Azure Key Vault.

## How they plug into Hardhat

All seven packages register with `extendConfig` or `extendEnvironment` from `hardhat/config`, the Hardhat 2 plugin API (`dist/index.js` in each tarball). Six of them add a key field to a network's config (`kmsKeyId`, `kmsResourceName` or `gcpKmsKeyName`) and, when it is set, replace `hre.network.provider` with Hardhat's HTTP provider wrapped in their own signer, so each network signs with one key. `@cuonghx.gu-tech/hardhat-gcp-kms-signer-plugin` adds `hre.getKmsSigners()` instead, which returns one ethers signer per entry of the network's `gcpKmsConfigs`.

Hardhat 3 replaced these extension points with hooks: "Adding new fields to the Hardhat Runtime Environment with `extendEnvironment` is no longer possible" ([Migrate from Hardhat 2](https://hardhat.org/docs/migrate-from-hardhat2), checked 2026-10-07).

hardhat-kms is a Hardhat 3 plugin. Its packages declare `hardhat` `^3.18.0` as a peer dependency. It registers a network hook, which handles the signing requests of KMS accounts on every connection ([How hardhat-kms works](how-it-works.md)).

## What hardhat-kms does

| Topic                      | hardhat-kms                                                                                                                                                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hardhat                    | Hardhat 3, `^3.18.0` as a peer dependency                                                                                                                                                                                                                 |
| How it plugs in            | A network hook at the JSON-RPC layer, so viem, ethers and Ignition use KMS accounts unchanged ([How hardhat-kms works](how-it-works.md))                                                                                                                  |
| Clouds                     | AWS KMS, Google Cloud KMS, and Azure Key Vault or Managed HSM, one package each ([Configuration](../reference/configuration.md#provider-packages))                                                                                                        |
| Keys per network           | Any number, by name in `kmsAccounts`, next to the network's own accounts and Ledger accounts ([Use several keys across networks](../guides/multiple-keys.md))                                                                                             |
| Signature checks           | Every signature is recovered locally and checked against the key's address before it is used; an optional `address` pin also refuses a key that derives to another address ([Every signature is verified](security-model.md#every-signature-is-verified)) |
| Keys from the command line | `--kms aws`, `--kms gcp` or `--kms azure` reads a key from Foundry's environment variables, without a config entry ([Migrate from Foundry](../guides/migrate-from-foundry.md#from-the-command-line-as-in-foundry))                                        |
| Signing history            | `kms history` lists a key's sign events from CloudTrail, Cloud Audit Logs or the Key Vault audit log ([`kms history`](../reference/tasks.md#kms-history))                                                                                                 |
| Tasks                      | Eight `kms` tasks, such as `kms accounts`, which checks each key's address and sign permission ([Hardhat kms tasks reference](../reference/tasks.md))                                                                                                     |

The contributor page [Signing prior art](../../contributor/research/signing-prior-art.md) (optional reading) compares the signature checks of Foundry and of the JavaScript KMS signer libraries that some of these plugins build on, check by check.

## When to use which

- A Hardhat 3 project: hardhat-kms. The seven packages above target Hardhat 2.
- A Hardhat 2 project that you are not moving to Hardhat 3: one of the packages above, for its cloud. hardhat-kms does not run on Hardhat 2.
- An Azure Key Vault key: hardhat-kms. None of the seven supports Azure.
- Moving a Hardhat 2 project to Hardhat 3: remove the Hardhat 2 signer, as [Migrate from Hardhat 2](https://hardhat.org/docs/migrate-from-hardhat2) says for every Hardhat 2 plugin, then name the same key under `kms.keys` ([Configuration](../reference/configuration.md)). The key and its address stay the same.

Signing from a Foundry project instead: [Comparison with Foundry](foundry-comparison.md). Choosing between a KMS key and other places to keep a key: [A KMS key or a private key in .env](kms-or-env-key.md) and [A KMS key or a Ledger](kms-or-ledger.md).
