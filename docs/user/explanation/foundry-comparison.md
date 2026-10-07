---
title: Comparison with Foundry
description: "hardhat-kms compared with Foundry's AWS and Google Cloud KMS signers: the checks it adds, and how each tool finds cloud credentials."
---

# Comparison with Foundry

Audience: Users choosing between Foundry and Hardhat for KMS signing.

## Differences from Foundry

What hardhat-kms adds over Foundry's KMS signers:

- GCP CRC32C integrity checks. Foundry has none.
- Post-sign verification of every signature. Foundry's Turnkey signer has none.
- Per-call timeouts on every provider.
- Multiple keys for every provider. Foundry allows one GCP key and one Turnkey key.
- An account listing that checks access.
- A `public-key` command.
- A chain-id guard on typed data.
- Protection against double broadcast when a client retries a send.

## Credentials

Neither tool keeps secrets in its config: both hand the key to the cloud's own SDK, which finds credentials in the environment. [How the plugin reaches your cloud](cloud-access.md) explains the plugin's side.

| Cloud                            | Foundry                                                                                                                                                                                                                                                                                  | hardhat-kms                                                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS                              | The AWS SDK for Rust's default chain: environment keys, profile, web identity, container, instance role                                                                                                                                                                                  | The AWS SDK for JavaScript's default chain: the same sources in the same order                                                                                      |
| AWS, profile and access keys set | The access keys in the environment win, even with `AWS_PROFILE` set                                                                                                                                                                                                                      | The profile wins: with the key's `profile` or `AWS_PROFILE` set, the access keys in the environment are ignored, with a warning                                     |
| AWS, per key                     | One `AWS_PROFILE` and one `AWS_REGION` for the whole run                                                                                                                                                                                                                                 | Each key can set its own `profile`, `region` and `endpoint`                                                                                                         |
| Google Cloud                     | Application Default Credentials: `GOOGLE_APPLICATION_CREDENTIALS`, then the gcloud ADC file in `~/.config/gcloud`, then the metadata server                                                                                                                                              | The same three sources in the same order. `CLOUDSDK_CONFIG` moves the gcloud ADC file, and `GOOGLE_CLOUD_QUOTA_PROJECT` sets the quota project                      |
| Azure                            | No released signer. The one proposed in [foundry-rs/foundry#17120](https://github.com/foundry-rs/foundry/pull/17120) picks one source from the variables that are set: a client secret, else a federated token file, else `az` then `azd`, then a managed identity with 10 s for a token | The same order, as one chain that skips the sources that are not set up. It also takes a certificate instead of a secret, and refuses username and password sign-in |

The AWS row with a profile and access keys is the one that changes which identity signs. A Foundry job that exports access keys and also sets `AWS_PROFILE` signs with the keys; the same environment under hardhat-kms signs with the profile. Set one or the other, never both ([Never set a profile and environment keys together](../reference/credentials.md#aws)).

## Other comparisons

- [Compared with other KMS signers](other-kms-signers.md): the Hardhat 2 `hardhat-kms-signer` packages and their forks.
- [A KMS key or a private key in .env](kms-or-env-key.md), the setup most Hardhat and Foundry projects start from.
- [A KMS key or a Ledger](kms-or-ledger.md), and both in one project.
