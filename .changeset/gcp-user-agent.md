---
"@hardhat-kms/gcp": patch
---

Every Cloud KMS request now carries the user agent `hardhat-kms/<version>`, so `callerSuppliedUserAgent` in the Cloud KMS Data Access audit log shows which calls came through the plugin. Anyone can send the same string, so the tag marks the plugin's calls but proves nothing.

Issue: [#126](https://github.com/aelmanaa/hardhat-kms/issues/126)
