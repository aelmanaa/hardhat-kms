---
"hardhat-kms": major
---

hardhat-kms 1.0 is a Hardhat 3 plugin that signs transactions, messages, typed data and EIP-7702 authorizations with secp256k1 keys in AWS KMS, Google Cloud KMS and Azure Key Vault, and the private key never leaves the service.

From 1.0, semver covers the public API that [Release channels and versioning](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/explanation/versioning.md#semver-and-the-public-api) lists. It has five parts. They are the config keys, the task names and their flags, the error codes, the account that `connection.kms.getAccount` returns, and the provider interface for plugin authors. What the API reference marks `Experimental` is outside it, and so is `hardhat-kms/provider-utils`. Only a major release removes or renames one of these, drops a Hardhat major or removes an error code from the catalogue.

The core package, `hardhat-kms`, works with one provider package per cloud. They are `@hardhat-kms/aws` for AWS KMS, `@hardhat-kms/gcp` for Google Cloud KMS and `@hardhat-kms/azure` for Azure Key Vault. The four packages are released together at one version, and each provider package requires the core at exactly its own version.

The eight tasks in the `kms` namespace are `kms accounts`, `kms address`, `kms public-key`, `kms sign`, `kms verify`, `kms sign-tx`, `kms sign-auth` and `kms history`. The [tasks reference](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/tasks.md) gives each one's flags, output and errors.

`connection.kms.getAccount(address)` returns a viem account for a KMS key, for viem's `signAuthorization`, a smart-account owner or a script with no wallet client. Its `signal` option takes an `AbortSignal` that cancels the account's KMS calls. [Library accounts](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/library-accounts.md) has its options, methods and refusals.

`kms history` lists a key's sign events from the provider's audit log. It reads AWS CloudTrail, Google Cloud Audit Logs or Azure Key Vault's audit events in a Log Analytics workspace. The plugin keeps no record of its own.

The plugin refuses some requests by design. No JSON-RPC method signs a bare 32-byte digest. Raw signing takes `kms sign --no-hash` or a `getAccount` account made with `rawSign: true`. Typed data whose `domain.chainId` names another chain than the connection's is refused, unless `kms.allowCrossChainTypedData` is `true`. A transaction that carries blobs (EIP-4844) is refused.

hardhat-kms 1.0 needs Hardhat `^3.18.0` and Node.js 22.13.0 or later. viem `^2.55.13` is an optional peer of `hardhat-kms`, needed only by `connection.kms.getAccount`. The [compatibility table](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/explanation/versioning.md#compatibility-table) lists the ranges.

The [live proof](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/live-proof.md) ran legacy, EIP-2930, EIP-1559 and EIP-7702 transactions and EIP-191 and EIP-712 signatures on Sepolia, with one key in each of the three clouds. Its transactions are in blocks 11872498 to 11872513, from commit `953a9e3`, the 0.10.0 release.

To check that the packages you installed were built from this repository, run `npm audit signatures` as [Verify a release](https://github.com/aelmanaa/hardhat-kms/blob/main/README.md#verify-a-release) says.

The [docs index](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/README.md) lists every tutorial, guide and reference page. The [security model](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/explanation/security-model.md) says what the plugin protects against and what it does not.

What should I do? Upgrade `hardhat-kms` and every provider package in the project to 1.0.0 together.

A community plugin, built in a personal capacity; not affiliated with or endorsed by Nomic Foundation, Amazon Web Services, Google or Microsoft.

Issue: [#284](https://github.com/aelmanaa/hardhat-kms/issues/284)
