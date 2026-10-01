---
"hardhat-kms": patch
---

Accept an EIP-7702 authorization's `r` and `s` as quantities, the form viem sends. For a KMS account's transaction, the plugin sends `r` and `s` to `eth_estimateGas` as quantities, which geth requires, and pads them to 32 bytes to validate and sign, so an authorization whose `r` or `s` starts with a zero byte is no longer refused. An `r` or `s` outside [1, n - 1] is now refused before any request to the node. Values longer than 32 bytes, or not hex, are still refused.
