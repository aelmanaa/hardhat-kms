# @hardhat-kms/safe

## 1.5.1

### Patch Changes

- Updated dependencies []:
  - hardhat-kms@1.5.1

## 1.5.0

### Minor Changes

- [#657](https://github.com/aelmanaa/hardhat-kms/pull/657) [`6dd5a48`](https://github.com/aelmanaa/hardhat-kms/commit/6dd5a4827c7bdad9823379c306ec282d595e93e0) Thanks [@aelmanaa](https://github.com/aelmanaa)! - New package `@hardhat-kms/safe`. Its task `kms safe propose` signs a Safe multisig transaction with an owner of the Safe and proposes it to the Safe Transaction Service, where the other owners confirm it. The owner is the network's KMS account by default, or with `--from <address>` any other account the network signs for in Hardhat: a key in its `accounts`, such as one from `hardhat-keystore`, or a Ledger in its `ledgerAccounts` with `@nomicfoundation/hardhat-ledger`. It works without a KMS key. On a network whose `accounts` is `"remote"`, it refuses a node's own account, so the node never signs. It supports Safe 1.3.0, 1.4.1 and 1.5.0 and every chain Safe's hosted service serves, and a self-hosted service per chain with `kmsSafe.services`.
  
  Before anything is signed, the task checks the chain, the Safe's code and version, that the proposer is an owner, the nonce, and that its hash matches the Safe's own `getTransactionHash`. It refuses a delegatecall unless `--delegatecall` is passed. After signing, it checks that the signature recovers to the proposer and passes the Safe's `checkNSignatures` before it posts. When the Safe's threshold is 1, the task asks at the terminal first, and `--yes` skips the question. `proposeSafeTransaction` does the same from code.
  
  To start, install `@hardhat-kms/safe` with `hardhat-kms` and `viem`, and the provider package of a KMS key if one proposes. Add it to `plugins` and set `kmsSafe.apiKey` to `configVariable("SAFE_TRANSACTION_SERVICE_API_KEY")` with a key from developer.safe.global. Then run `npx hardhat kms safe propose <safe> <to> --network sepolia`, with `--from <owner>` for a local key or a Ledger.
  
  Issues: [#653](https://github.com/aelmanaa/hardhat-kms/issues/653), [#658](https://github.com/aelmanaa/hardhat-kms/issues/658)

### Patch Changes

- Updated dependencies [[`ad09100`](https://github.com/aelmanaa/hardhat-kms/commit/ad09100ef0f838f46a229b520d91752f365ef231), [`4cd3846`](https://github.com/aelmanaa/hardhat-kms/commit/4cd38463309557d32dec5b981bba700365560189), [`4609f97`](https://github.com/aelmanaa/hardhat-kms/commit/4609f9754b9f30200ed2eb9cc6ff416872f5f460), [`6dd5a48`](https://github.com/aelmanaa/hardhat-kms/commit/6dd5a4827c7bdad9823379c306ec282d595e93e0), [`88675d7`](https://github.com/aelmanaa/hardhat-kms/commit/88675d7696625c9f9d4fa3fea140803f3e926c8b)]:
  - hardhat-kms@1.5.0
