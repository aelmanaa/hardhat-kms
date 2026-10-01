---
"hardhat-kms": patch
---

List the network's KMS addresses in "unknown account" errors. When a transaction or signing request names an address that is neither a KMS account nor a local account, the error from Hardhat or the node (EDR, Geth, Reth or Anvil) now ends with the checksummed KMS addresses, at most 10. A mistyped address or a key missing from `kmsAccounts` is then easy to spot, also in Hardhat's CLI output. The error keeps its class, code and data, and names no key ids. Other errors pass through unchanged.
