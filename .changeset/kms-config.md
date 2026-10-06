---
"hardhat-kms": minor
---

The `kms` config section and `kmsAccounts` on networks are new. Keys for AWS KMS, Google Cloud KMS and Azure Key Vault are validated when the config loads, with errors that name the exact config path. Values from configuration variables are checked when first read.

Issue: [#10](https://github.com/aelmanaa/hardhat-kms/issues/10)
