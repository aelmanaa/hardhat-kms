---
"@hardhat-kms/safe": minor
---

New package `@hardhat-kms/safe`. Its task `kms safe propose` signs a Safe multisig transaction with a KMS key that owns the Safe and proposes it to the Safe Transaction Service, where the other owners confirm it. It supports Safe 1.3.0, 1.4.1 and 1.5.0 and every chain Safe's hosted service serves, and a self-hosted service per chain with `kmsSafe.services`.

Before the key signs, the task checks the chain, the Safe's code and version, that the key is an owner, the nonce, and that its hash matches the Safe's own `getTransactionHash`. It refuses a delegatecall unless `--delegatecall` is passed. After signing, it checks the signature with the Safe's `checkNSignatures` before it posts. When the Safe's threshold is 1, the task asks at the terminal first, and `--yes` skips the question. `proposeSafeTransaction` does the same from code.

To start, install `@hardhat-kms/safe` with `hardhat-kms`, the provider package of your key and `viem`. Add it to `plugins` and set `kmsSafe.apiKey` to `configVariable("SAFE_TRANSACTION_SERVICE_API_KEY")` with a key from developer.safe.global. Then run `npx hardhat kms safe propose <safe> <to> --network sepolia`.

Issue: [#653](https://github.com/aelmanaa/hardhat-kms/issues/653)
