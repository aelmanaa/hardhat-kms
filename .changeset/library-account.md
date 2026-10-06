---
"hardhat-kms": minor
---

`connection.kms.getAccount(address)` returns a viem `LocalAccount` for a KMS account of the connection, for viem's `signAuthorization`, smart-account owners and scripts outside a wallet client. It signs messages, typed data, transactions of types 0, 1, 2 and 4, and EIP-7702 authorizations, with the same checks as the RPC path. For viem-typed inputs it returns the bytes viem's `privateKeyToAccount` returns for the same key. A string `domain.chainId` in typed data, which viem drops, is kept, so the digest is the one a contract expects. Before any KMS call it refuses a transaction or authorization for another chain, a blob transaction, other types, a transaction viem's serializer encodes differently, and a chain-0 authorization unless `allowChainZeroAuthorization` is set. `sign({ hash })` exists only with `rawSign: true`, which prints a warning. After `connection.close()`, the account refuses to sign. viem is a new optional peer dependency, `^2.55.13`, loaded only by `getAccount`.

Issue: [#51](https://github.com/aelmanaa/hardhat-kms/issues/51)
