# Signing pipeline and security design

Audience: Contributors and security reviewers.

Status: M1 implements the signature pipeline for digests, messages and typed data, along with the address pin check and the vendored EIP-712 encoder. M5 adds transactions ([#24](https://github.com/aelmanaa/hardhat-kms/issues/24)). Each provider's identity checks come with its adapter (M3, M6).

## Signature pipeline

Every signature, from any adapter, goes through the same pipeline in `signer/kms-signer.ts` before it is used:

1. Strict parse with noble (DER or compact).
2. Range check on r and s.
3. Low-S normalization.
4. Trial recovery against the cached public key, or against the pinned address for adapters without `getPublicKey`. No match throws. Recovery ids that need an x-reduced point are rejected.
5. A final check with the matching verifier: `recoverSender` for transactions, `eip191Signer.verify` for messages, `verifyTyped` for typed data.

Every noble `verify` call passes `prehash:false`. If trial recovery fails, the signer makes one fresh signature attempt and then throws. The `yParity` an adapter returns is a hint only; the core always re-derives and verifies it.

## Key identity and pinning

The plugin caches a public key only after it matches the `address` pin, and it releases no signature before that check. Each provider adds its own identity checks:

| Provider | Checks                                                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS      | Signs with the ARN returned by `GetPublicKey`, never with the alias. Asserts KeySpec, KeyUsage and SigningAlgorithms. Requests use `MessageType: DIGEST`.                       |
| GCP      | Signs with the configured key version. Checks `name` on both responses and that `algorithm` is `EC_SIGN_SECP256K1_SHA256`. A disabled or destroyed version gives a clear error. |
| Azure    | Signs with the versioned id using `ES256K`, and requires each sign response's `kid` to name that version. Checks kty, crv, enabled, keyOps, nbf and exp.                        |

Signing with the ARN instead of the alias means a repointed alias cannot switch keys between the address lookup and the signature. Azure pins the version of an unversioned key for the same reason.

GCP responses get an integrity check. The plugin sends `digestCrc32c`, requires `verifiedDigestCrc32c` to be true in the response, and checks `signatureCrc32c` and, on the public key, `pemCrc32c`, with the core's table-based CRC32C implementation (`crc32c` in `hardhat-kms/provider-utils`). A missing checksum counts as a mismatch. A mismatch is retried at most three times; a response for another key version fails at once.

## Errors, logs and secrets

Errors are `HardhatPluginError("hardhat-kms", …)` built from an allow-list of fields: provider, operation, display id, SDK error name or code, HTTP status and request id. Raw SDK errors are never attached as `cause`, and secrets are never included.

`debug` output uses loggers from `kmsDebug()` in `packages/hardhat-kms/src/internal/debug.ts`, under `hardhat:kms:*`. It may contain digests, addresses, display ids, provider ids, operation names, the plugin's own request ids, timings, error class names and the plugin's `InvalidSignatureError` messages. `packages/hardhat-kms/test/integration/debug.test.ts` plants secrets in configuration variables (including a third-party key's token) and in a provider's error message, and fails if any of them reaches the output. `kmsDebug()` accepts plain values only and replaces any object or error it is given, so a stray `log("%o", error)` cannot dump request details. Signer lines use the display id from the configuration, not the one the adapter reports. See [Debug output](../user/guides/debug-output.md).

`ResolvedConfigurationVariable` carries no name, so descriptors capture `ConfigurationVariable.name` at resolve time and produce `{ value, maskedAs: "<NAME>" }`. Ids derived from a masked value (an ARN, a pinned version) inherit the mask.

## Threat model summary

| Risk                                                                       | Control                                                                                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| A script or dependency asks the key to sign an arbitrary 32-byte digest    | No RPC method signs a bare digest. `--no-hash` exists only in the `kms sign` task.                                 |
| A signature intended for one chain is used on another                      | Chain-id check per connection, explicit `chainId` on every transaction, and the typed-data `domain.chainId` check. |
| The configured key changes underneath the user (rotation, repointed alias) | Address pin, AWS signing with the ARN from `GetPublicKey`, pinned GCP and Azure versions.                          |
| An adapter or KMS returns a malformed signature, or one from the wrong key | The signature pipeline: nothing is released unless it recovers to the account address.                             |
| Corruption of the digest or signature between the plugin and GCP           | CRC32C in both directions.                                                                                         |
| Credentials or identifiers leak through errors and logs                    | No secrets in config, allow-listed errors, restricted `debug` output, `<VAR_NAME>` masking.                        |
| A client retry broadcasts a transaction twice                              | Error code -32000 plus the local hash after broadcast, and the post-broadcast retry cache.                         |

The plugin does not protect against these (the full security model is [#39](https://github.com/aelmanaa/hardhat-kms/issues/39)):

- Nonce collisions between separate processes using the same key.
- Access to the key itself, which the provider's IAM or RBAC controls. The setup guides for [AWS](../user/guides/aws-kms-setup.md), [Google Cloud](../user/guides/gcp-kms-setup.md) and [Azure](../user/guides/azure-key-vault-setup.md) give minimal permissions, including the AWS conditions `kms:SigningAlgorithm` and `kms:MessageType`.
- Key deletion. Deleting a KMS key loses the funds at its address forever. The user guide [Prevent and recover from losing a key](../user/guides/key-loss.md) covers each provider's waiting period, the undo paths and lockout.

## Vendored EIP-712

EIP-712 hashing comes from micro-eth-signer 0.19, vendored: `core/typed-data` plus `advanced/abi-mapper`, about 500 lines. micro-eth-signer 0.19 does not export typed-data hashing, and this is the exact code Hardhat core uses, with the same strictness. A test re-checks the vendored code against the package's `verifyTyped`.

`ox` was considered and rejected. It brings about 30 MB of transitive dependencies (zod 4, post-quantum, bip39 and more) and silently accepts undeclared fields.

The vendored code lives in `packages/hardhat-kms/src/internal/vendor/micro-eth-signer/` with SPDX MIT headers and a `THIRD_PARTY_NOTICES.md`. It is excluded from oxfmt and the jsdoc lint. `micro-packed`, already a dependency of micro-eth-signer, is declared explicitly.
