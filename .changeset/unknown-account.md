---
"hardhat-kms": patch
---

List the network's KMS addresses in "unknown account" errors. When a transaction or signing request names an address that is neither a KMS account nor a local account, the error from the node or Hardhat now ends with the checksummed KMS addresses, at most 10, so a mistyped address or a key missing from `kmsAccounts` is easy to spot. The error keeps its class, code and data, and names no key ids. Other errors pass through unchanged.
