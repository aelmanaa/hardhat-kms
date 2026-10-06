---
"@hardhat-kms/aws": minor
---

`@hardhat-kms/aws` adds the AWS KMS provider as its own package. It checks that the key is a secp256k1 signing key and signs with the key ARN. It depends on `@aws-sdk/client-kms` 3.1143.0 or later, so there is no SDK to install separately.

Issue: [#16](https://github.com/aelmanaa/hardhat-kms/issues/16)
