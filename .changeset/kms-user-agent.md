---
"@hardhat-kms/aws": patch
"@hardhat-kms/azure": patch
---

Every AWS KMS and Azure Key Vault request now carries the user agent `hardhat-kms/<version>`, so CloudTrail's `userAgent` and the Key Vault audit log's `ClientInfo` show which calls came through the plugin. Anyone can send the same string, so the tag marks the plugin's calls but proves nothing.

Issue: [#126](https://github.com/aelmanaa/hardhat-kms/issues/126)
