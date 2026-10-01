---
"hardhat-kms": patch
---

Accept an EIP-7702 authorization's `r` and `s` as quantities, the form viem sends. The plugin left-pads them to 32 bytes before it validates and signs a KMS account's transaction, so an authorization whose `r` or `s` starts with a zero byte is no longer refused. Values longer than 32 bytes, or not hex, are still refused.
