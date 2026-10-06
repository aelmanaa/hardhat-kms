---
"hardhat-kms": patch
---

The plugin now accepts an EIP-7702 authorization whose `r` or `s` is a quantity, the form viem sends. Before, the plugin refused an authorization whose `r` or `s` started with a zero byte. The plugin now refuses an `r` or `s` of 0, or of n or more, before any request to the node. It still refuses a value longer than 32 bytes, or not hex.

Issue: [#140](https://github.com/aelmanaa/hardhat-kms/issues/140)
