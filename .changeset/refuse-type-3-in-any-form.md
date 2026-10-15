---
"hardhat-kms": patch
---

`eth_sendTransaction` and `eth_signTransaction` from a KMS account now refuse type 3 in every form with `core.tx.blob`, before any request to the node: `"0x03"`, `"0X3"`, the number `3`, a bigint, `"3"` and `"eip4844"`, with or without surrounding whitespace, not only `"0x3"`. These were signed as legacy or EIP-1559 transactions before. Every other `type` is still ignored, as in Hardhat.

Issue: [#484](https://github.com/aelmanaa/hardhat-kms/issues/484)
