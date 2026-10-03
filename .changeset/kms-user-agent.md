---
"@hardhat-kms/aws": patch
"@hardhat-kms/azure": patch
---

Tag every AWS KMS and Azure Key Vault request with the user agent `hardhat-kms/<version>`, so CloudTrail's `userAgent` and the Key Vault audit log's `ClientInfo` show which calls came through the plugin. The client reports the tag and anyone can send the same string, so it marks the plugin's calls but proves nothing.
