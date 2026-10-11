---
"hardhat-kms": major
---

hardhat-kms 1.0 is a Hardhat 3 plugin that signs transactions, messages, typed data and EIP-7702 authorizations with secp256k1 keys in AWS KMS, Google Cloud KMS and Azure Key Vault, and the private key never leaves the service.

From 1.0, semver covers the config keys, task names and flags, error codes, the account returned by `connection.kms.getAccount`, and the provider interface for plugin authors. Removing or renaming one of these, or dropping a Hardhat major, requires a major release. Items marked `Experimental` in the API reference and `hardhat-kms/provider-utils` may change in a minor release. [Release channels and versioning](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/explanation/versioning.md#semver-and-the-public-api) defines the public API.

The core package, `hardhat-kms`, works with one provider package per cloud. They are `@hardhat-kms/aws` for AWS KMS, `@hardhat-kms/gcp` for Google Cloud KMS and `@hardhat-kms/azure` for Azure Key Vault. The four packages are released together at one version, and each provider package requires the core at exactly its own version.

The eight tasks in the `kms` namespace are `kms accounts`, `kms address`, `kms public-key`, `kms sign`, `kms verify`, `kms sign-tx`, `kms sign-auth` and `kms history`. The [tasks reference](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/tasks.md) gives each one's flags, output and errors.

`connection.kms.getAccount(address)` returns a viem account for a KMS key. It supports `signAuthorization` and can serve as a smart-account owner or sign directly in a script. Its `signal` option cancels in-flight KMS calls and prevents further signing after it aborts. [Library accounts](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/library-accounts.md) documents its options, methods and refusals.

`kms history` lists a key's sign events from the provider's audit log. It reads AWS CloudTrail, Google Cloud Audit Logs or Azure Key Vault's audit events in a Log Analytics workspace. The plugin keeps no record of its own.

No JSON-RPC method signs a bare 32-byte digest. Raw signing requires `kms sign --no-hash` or a `getAccount` account created with `rawSign: true`. Typed data whose `domain.chainId` differs from the connection's chain is refused unless `kms.allowCrossChainTypedData` is `true`. Blob transactions (EIP-4844) are refused. A self-authorization in an EIP-7702 transaction must use chain 0 or the transaction's chain and start at the transaction nonce plus 1. Further self-authorizations need consecutive nonces.

hardhat-kms 1.0 needs Hardhat `^3.18.0` and Node.js 22.13.0 or later. viem `^2.55.13` is an optional peer of `hardhat-kms`, needed only by `connection.kms.getAccount`. The [compatibility table](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/explanation/versioning.md#compatibility-table) lists the ranges.

The pre-1.0 [registry acceptance pass](https://github.com/aelmanaa/hardhat-kms/issues/466) tested the published 0.10.1 packages with all three clouds. The [0.10.1 live proof](https://github.com/aelmanaa/hardhat-kms/blob/6864a19d7ab4d6e0c88dd99b1892b9e6faaf05c4/docs/live-proof.md) records legacy, EIP-2930, EIP-1559 and EIP-7702 transactions and EIP-191 and EIP-712 signatures on Sepolia at release commit `90d1b96`, in blocks 11886654 to 11886668. Promoting 1.0.0 requires a new Sepolia proof for the `v1.0.0` tag commit.

To check that the packages you installed were built from this repository, run `npm audit signatures` as [Verify a release](https://github.com/aelmanaa/hardhat-kms/blob/main/README.md#verify-a-release) says.

The [docs index](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/README.md) lists every tutorial, guide and reference page. The [security model](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/explanation/security-model.md) says what the plugin protects against and what it does not.

What should I do? Upgrade `hardhat-kms` and every provider package in the project to 1.0.0 together. This release adds no API break over 0.10.1.

A community plugin, built in a personal capacity; not affiliated with or endorsed by Nomic Foundation, Amazon Web Services, Google or Microsoft.

Issue: [#284](https://github.com/aelmanaa/hardhat-kms/issues/284)
