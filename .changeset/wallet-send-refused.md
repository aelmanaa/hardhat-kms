---
"hardhat-kms": patch
---

The plugin now answers `wallet_sendTransaction` from a KMS account with JSON-RPC error `-32601` (method not found), and the request no longer reaches the node. viem sends this method once after an `eth_sendTransaction` error such as `-32000`. viem now throws the `eth_sendTransaction` error instead. When that send got no answer, the error carries the transaction hash. Later sends on the same client still go through `eth_sendTransaction`, so the KMS key signs each one. Before, an endpoint that answered `wallet_sendTransaction` with a hash made viem report that hash as sent, and every later send on the client skipped the plugin. A `wallet_sendTransaction` from any other address passes through unchanged. The new error is `core.tx.wallet-send-refused`.

What should I do? Nothing, if you send with viem or hardhat-viem. ethers and Ignition never send `wallet_sendTransaction`. If your own code calls `wallet_sendTransaction` for a KMS account, call `eth_sendTransaction` instead.

Issue: [#350](https://github.com/aelmanaa/hardhat-kms/issues/350)
