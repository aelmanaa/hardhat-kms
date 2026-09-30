---
"hardhat-kms-aws": minor
---

Add the AWS KMS provider as its own package. It checks that a key is a secp256k1 signing key, signs with the key ARN rather than an alias, and depends on `@aws-sdk/client-kms` 3.1143.0 or later, so there is no SDK to install separately.
