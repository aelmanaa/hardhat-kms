---
"hardhat-kms": minor
---

Add the `kms` config section and `kmsAccounts` on networks. Keys for AWS KMS, Google Cloud KMS and Azure Key Vault are validated when the config loads, with errors that name the exact config path, and values from configuration variables are checked when first read.
