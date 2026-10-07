---
"hardhat-kms": patch
---

The plugin now answers `wallet_sendCalls` (EIP-5792) from a KMS account with JSON-RPC error `-32601` (method not found), and the request no longer reaches the node. viem's `sendCalls` sends this method. Before, an endpoint that answered `wallet_sendCalls` with a batch id made viem report calls as sent that the KMS key never signed. Now, with `experimental_fallback: true`, viem sends each call as its own transaction, and the KMS key signs each one. Without it, `sendCalls` throws viem's `TransactionExecutionError`, whose details carry the plugin's message (catalogue entry `core.tx.wallet-send-calls-refused`). A `wallet_sendCalls` without `from`, or from any other address, passes through unchanged.

What should I do? If you call viem's `sendCalls` from a KMS account, pass `experimental_fallback: true`, or send each call with `sendTransaction`.

Issue: [#352](https://github.com/aelmanaa/hardhat-kms/issues/352)
