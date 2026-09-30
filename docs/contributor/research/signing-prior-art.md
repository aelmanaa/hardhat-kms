# Signing prior art

Audience: contributors and security reviewers who want to know why the signing pipeline has each of its checks.

Status: research from 2026-09-30, done by reading source code. Nothing was run against a live KMS. Versions and commits are pinned below; later releases may differ. The hardhat-kms column describes the signing core in [#4](https://github.com/aelmanaa/hardhat-kms/pull/4).

The [signing pipeline](../signing-pipeline.md) turns a KMS signature into an Ethereum signature. While the signing core was in review, we compared it with how Foundry and the most downloaded JavaScript KMS signers do the same job. This page records what we found. The decision it supports is [0004: Recover the parity against the known key and verify every signature](../decisions/0004-verify-every-signature.md).

## What was compared

- Foundry, through alloy's signer crates: `alloy-signer-aws`, `alloy-signer-gcp` and `alloy-signer-turnkey` at alloy `c6a2f8c` (2026-09-26), the Azure Key Vault signer added in [alloy#4267](https://github.com/alloy-rs/alloy/pull/4267) (merge commit `3834f7e`, 2026-09-30), Foundry's `WalletSigner` in foundry-core `6228965`, and `cast` in Foundry `336712c`. The archived ethers-rs (`6e2ff0e`) for the earlier AWS signer.
- JavaScript and TypeScript packages on npm, chosen by download counts and GitHub stars: `@valora/viem-account-hsm-gcp` 1.2.19, `aws-kms-signer` 0.5.3, `@cloud-cryptographic-wallet/aws-kms-signer` and `/cloud-kms-signer` 0.1.2 (with `/signer` 0.0.5), `ethers-gcp-kms-signer` 1.1.6, `ethers-aws-kms-signer` 1.3.2, `@cuonghx.gu-tech/ethers-{aws,gcp}-kms-signer` 0.9.1, `viem-kms-signer` 1.0.1, `@rumblefishdev/eth-signer-kms` 4.3.1, `@rumblefishdev/hardhat-kms-signer` 2.0.0 (which uses `eth-signer-kms` 3.1.0), `@web3-kms-signer/*` 1.0.6 to 1.0.16, and `evm-kms-signer` 2.0.4.
- For reference: `@nomicfoundation/hardhat-ledger` 3.1.0, `@turnkey/viem` 0.14.43, `@openzeppelin/defender-sdk-relay-signer-client` 2.7.1, `@mysten/gcp-kms-signer` 0.2.31 (a Sui signer), viem 2.57.1 and ethers 6.17.0.

We found no JavaScript Ethereum signer for Azure Key Vault on npm.

## Check by check

| Check                                                 | Foundry / alloy                                                                   | JavaScript packages                                                                                         | hardhat-kms |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------- |
| Public key fetched once, address derived              | Yes                                                                               | Most; `aws-kms-signer` fetches it on every signature                                                        | Yes         |
| Configured address checked before the first signature | No for KMS keys (only encrypted keystores, and `cast`'s `--from` check afterward) | No                                                                                                          | Yes         |
| Strict DER parse, r and s in [1, n - 1]               | Yes (`ecdsa` crate)                                                               | Only `@valora/viem-account-hsm-gcp` (noble); the others use general ASN.1 decoders or a hand-written parser | Yes         |
| Low-S normalization                                   | Yes for AWS, GCP and Azure                                                        | Yes, in every KMS package compared                                                                          | Yes         |
| Both recovery bits tried, error if neither matches    | Yes; before 2025, a panic (see below)                                             | Most; five packages return `v = 28` unchecked                                                               | Yes         |
| Final signature verification                          | Implicit in recovery                                                              | Implicit in recovery, where recovery is checked                                                             | Explicit    |
| EIP-191 and EIP-712 results re-verified               | No                                                                                | No                                                                                                          | Yes         |
| One retry after a bad signature                       | No                                                                                | No                                                                                                          | Yes         |
| Timeout on each KMS call                              | No; Foundry sets none, and the AWS SDK has no operation timeout by default        | No                                                                                                          | Yes         |
| Provider error text kept out of errors                | No; SDK errors are passed through                                                 | No                                                                                                          | Yes         |

A recovered public key always verifies the signature it came from, so matching it against the known key already proves the signature is valid for that digest. The explicit final verification repeats that proof independently, at the cost of one more curve operation.

## Failure modes found

These are the problems the pipeline's checks exist to catch. Each one appears in published package code.

- **Unchecked recovery bit.** Several packages try `v = 27` and, if the recovered address does not match, return `v = 28` without recovering again. With the wrong key or a bad parse, the result is a signature that recovers to a different address. It appears in `ethers-aws-kms-signer` 1.3.2 and `ethers-gcp-kms-signer` 1.1.6 (`determineCorrectV`), `viem-kms-signer` 1.0.1, and both `@cuonghx.gu-tech/ethers-{aws,gcp}-kms-signer` 0.9.1. The pipeline tries both bits against the known key and fails if neither matches.
- **A panic instead of an error.** ethers-rs (`ethers-signers/src/aws/utils.rs` at `6e2ff0e`) and alloy called `panic!("bad sig")` when no recovery bit matched. alloy replaced it with an error in [#2880](https://github.com/alloy-rs/alloy/pull/2880) (AWS, 2025-09-18) and [#2970](https://github.com/alloy-rs/alloy/pull/2970) (GCP, merged through #3011 on 2025-10-09).
- **Values that lose a leading zero.** `@cloud-cryptographic-wallet/signer` 0.0.5 converts a normalized `s` to bytes with no fixed length, so about one signature in 256 gets a 31-byte `s` and fails its 65-byte length check ([cloud-cryptographic-wallet#607](https://github.com/odanado/cloud-cryptographic-wallet/issues/607)). The pipeline encodes `r` and `s` as 32 bytes each.
- **Lenient DER parsing.** The hand-written parser in `evm-kms-signer` 2.0.4 accepts trailing bytes, integers with unneeded leading zeros, and a 33-byte integer without a leading zero. The pipeline uses noble's DER parser, which rejects all three, and then checks that `r` and `s` are in range.
- **Skipped integrity checks.** `evm-kms-signer` 2.0.4 checks `signatureCrc32c` only when `verifiedDigestCrc32c` is true, so a false value skips the check instead of failing. alloy's GCP signer neither sends nor checks CRC32C. The GCP adapter will require all five checks ([#29](https://github.com/aelmanaa/hardhat-kms/issues/29)).
- **Wrong key version or type.** `@web3-kms-signer/kms-provider-gcp` 1.0.6 hard-codes GCP key version `1`. Several packages, including `ethers-aws-kms-signer` 1.3.2 and `aws-kms-signer` 0.5.3, take the key bytes out of the SPKI without checking the curve, so a P-256 key yields an address instead of a clear error. The pipeline checks the curve and that the point is on it; the adapters check key type and version ([#16](https://github.com/aelmanaa/hardhat-kms/issues/16), [#29](https://github.com/aelmanaa/hardhat-kms/issues/29), [#30](https://github.com/aelmanaa/hardhat-kms/issues/30)).
- **Trusting the returned `v`.** The remote-signer clients `@turnkey/viem` 0.14.43, `@openzeppelin/defender-sdk-relay-signer-client` 2.7.1 and `alloy-signer-turnkey` use `r`, `s` and `v` as the service returns them, with no local recovery check. The planned Turnkey adapter re-derives the parity and verifies the signature ([roadmap](../roadmap.md)).
- **Provider responses in logs and errors.** `viem-kms-signer` 1.0.1 logs the raw KMS response when signing fails, and `ethers-aws-kms-signer` 1.3.2 puts the AWS SDK error into its own error message. hardhat-kms reduces a provider SDK error to its class name.

## What we adopted from others

- From alloy's Azure signer: checking that every signing response comes from the pinned key version ([#30](https://github.com/aelmanaa/hardhat-kms/issues/30)), and rejecting a signature whose recovery needs an x-reduced point. The pipeline tries only recovery ids 0 and 1, so such a signature fails.
- From `@cloud-cryptographic-wallet/cloud-kms-signer` and `@web3-kms-signer/kms-provider-gcp`: between them they send `digestCrc32c`, require `verifiedDigestCrc32c`, and check `signatureCrc32c`, `pemCrc32c` and the returned key `name`. The GCP adapter does all of these ([#29](https://github.com/aelmanaa/hardhat-kms/issues/29)).
- From `@mysten/gcp-kms-signer`: checking the key version's `algorithm` and failing with a clear error before signing ([#29](https://github.com/aelmanaa/hardhat-kms/issues/29)).
