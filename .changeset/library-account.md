---
"hardhat-kms": minor
---

Add `connection.kms.getAccount(address)`, which returns a viem `LocalAccount` for a KMS account of the connection, for viem's `signAuthorization`, smart-account owners and scripts outside a wallet client. It signs messages, typed data, transactions of types 0, 1, 2 and 4, and EIP-7702 authorizations, with the same checks as the RPC path, and returns the bytes viem's `privateKeyToAccount` returns for the same key. Before any KMS call it refuses a transaction or authorization for another chain, blob transactions, other types, a transaction viem's serializer encodes differently, and a chain-0 authorization unless `allowChainZeroAuthorization` is set. `sign({ hash })` exists only with `rawSign: true`, which prints a warning (decision 0014). Sends through the account bypass the plugin's send lock; send with `connection.viem.getWalletClient(address)` instead. viem is a new optional peer dependency, `^2.47.6`, loaded only by `getAccount`.
