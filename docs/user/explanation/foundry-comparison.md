---
title: Comparison with Foundry
description: "hardhat-kms compared with Foundry's AWS, Google Cloud and Turnkey signers: the checks it adds, and how each tool finds its credentials."
---

# Comparison with Foundry

Audience: Users choosing between Foundry and Hardhat for KMS signing.

Compared with Foundry at commit `336712c`, foundry-core `6228965` and alloy `c6a2f8c`, and with the Azure signer proposed in [foundry#17120](https://github.com/foundry-rs/foundry/pull/17120), all read from source on 2026-09-30 ([Signing prior art](../../contributor/research/signing-prior-art.md)). The Turnkey rows compare Foundry at commit `f1e236b`, foundry-core `fe2413a`, alloy `6eb3cbd` and its `turnkey_client` 0.7.0, read from source on 2026-10-16 ([Turnkey provider: Foundry parity](../../contributor/research/turnkey.md#foundry-parity)). Nothing was run: "read from source" means read, not tested. Later Foundry releases may differ.

## Differences from Foundry

What hardhat-kms adds over Foundry's KMS signers, and where it works differently:

- GCP CRC32C integrity checks. Foundry has none.
- Post-sign verification of every signature. Foundry's Turnkey signer has none.
- Per-call timeouts on every provider.
- Multiple keys for every provider. Foundry allows one GCP key and one Turnkey key.
- An account listing that checks access. A Turnkey key's access is checked only with `--check-sign`, which spends one signature: the plugin cannot read a Turnkey account's public key.
- A `public-key` command.
- A chain-id guard on typed data.
- Protection against double broadcast when a client retries a send.
- Turnkey transactions reach Turnkey as the unsigned transaction, through `sign_transaction`, so Turnkey's policies can read their fields (`eth.tx.*`), such as the recipient, the chain and the value. Foundry sends a transaction's 32-byte hash, so a Turnkey policy cannot limit its transactions. A policy that allows only `SIGN_RAW_PAYLOAD` works for Foundry and denies transactions under hardhat-kms; [Set up a Turnkey wallet account](../guides/turnkey-setup.md#the-policies) gives the policy that allows them.
- Turnkey messages and typed data reach Turnkey as the EIP-191 message and the typed data, so Turnkey's policies and activity log see what was signed. Foundry sends a 32-byte hash for every request. A Turnkey policy that allows only `HASH_FUNCTION_NO_OP` works for Foundry and denies messages under hardhat-kms, and typed data too when it also requires `PAYLOAD_ENCODING_HEXADECIMAL`; [Set up a Turnkey wallet account](../guides/turnkey-setup.md#policies-written-for-foundry) gives a policy that allows both tools.
- Turnkey requests that are rate-limited, fail with a server error or get no answer are sent again with the same body, so Turnkey does not sign twice. Foundry does not retry them.
- Turnkey error messages never quote Turnkey's response, which can name organizations. Foundry prints the response.

## Credentials

Neither tool keeps secrets in its config: both read cloud credentials the way the cloud's own SDK does, and Turnkey's API key from a variable. [Cloud credentials for KMS signing](cloud-access.md) explains the plugin's side.

| Cloud                            | Foundry                                                                                                                                                                                                                                                                                  | hardhat-kms                                                                                                                                                                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS                              | The AWS SDK for Rust's default chain: environment keys, profile, web identity, container, instance role                                                                                                                                                                                  | The AWS SDK for JavaScript's default chain: the same sources in the same order                                                                                                                                                                                            |
| AWS, profile and access keys set | The access keys in the environment win, even with `AWS_PROFILE` set                                                                                                                                                                                                                      | The profile wins: with the key's `profile` or `AWS_PROFILE` set, the access keys in the environment are ignored, with a warning                                                                                                                                           |
| AWS, per key                     | One `AWS_PROFILE` and one `AWS_REGION` for the whole run                                                                                                                                                                                                                                 | Each key can set its own `profile`, `region` and `endpoint`                                                                                                                                                                                                               |
| Google Cloud                     | Application Default Credentials: `GOOGLE_APPLICATION_CREDENTIALS`, then the gcloud ADC file in `~/.config/gcloud`, then the metadata server                                                                                                                                              | The same three sources in the same order. `CLOUDSDK_CONFIG` moves the gcloud ADC file, and `GOOGLE_CLOUD_QUOTA_PROJECT` sets the quota project                                                                                                                            |
| Azure                            | No released signer. The one proposed in [foundry-rs/foundry#17120](https://github.com/foundry-rs/foundry/pull/17120) picks one source from the variables that are set: a client secret, else a federated token file, else `az` then `azd`, then a managed identity with 10 s for a token | The same order, as one chain that skips the sources that are not set up. It also takes a certificate instead of a secret, and refuses username and password sign-in                                                                                                       |
| Turnkey                          | `--turnkey` reads `TURNKEY_API_PRIVATE_KEY`, `TURNKEY_ORGANIZATION_ID` and `TURNKEY_ADDRESS` from the environment. One key per run                                                                                                                                                       | Each key names its organization and address in the config. The API private key is a configuration variable only, read from the environment or `hardhat-keystore`, so Foundry's variable names work. The address is written in the config, not read from `TURNKEY_ADDRESS` |

The AWS row with a profile and access keys is the one that changes which identity signs. A Foundry job that exports access keys and also sets `AWS_PROFILE` signs with the keys; the same environment under hardhat-kms signs with the profile. Set one or the other, never both ([Never set a profile and environment keys together](../reference/credentials.md#aws)).

## Other comparisons

- [Compared with other KMS signers](other-kms-signers.md): the Hardhat 2 `hardhat-kms-signer` packages and their forks.
- [A KMS key or a private key in .env](kms-or-env-key.md): the setup most Hardhat and Foundry projects start from.
- [A KMS key or a Ledger](kms-or-ledger.md): a device prompt for each signature, and both in one project.
