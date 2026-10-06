---
"hardhat-kms": patch
---

An "unknown account" error now ends with the network's KMS addresses. When a transaction or signing request names an address that is neither a KMS account nor a local account, the error from Hardhat or the node lists the checksummed KMS addresses, at most 10. The error keeps its class, code and data, and names no key ids. Other errors pass through unchanged.

Issue: [#119](https://github.com/aelmanaa/hardhat-kms/issues/119)
