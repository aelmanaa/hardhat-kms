---
"hardhat-kms": patch
---

The plugin now accepts an EIP-7702 authorization whose `r` or `s` is a quantity, the form viem sends. Before, an authorization whose `r` or `s` started with a zero byte was refused. An `r` or `s` outside the range 1 to n - 1 is now refused before any request to the node. A value longer than 32 bytes, or not hex, is still refused.

Issue: [#140](https://github.com/aelmanaa/hardhat-kms/issues/140)
