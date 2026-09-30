---
"hardhat-kms": minor
---

Add the AWS KMS provider. It checks that a key is a secp256k1 signing key, signs with the key ARN rather than an alias, and supports `@aws-sdk/client-kms` 3.714.0 and later.
