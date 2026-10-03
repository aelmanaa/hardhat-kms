---
"@hardhat-kms/gcp": patch
---

Tag every Cloud KMS request with the user agent `hardhat-kms/<version>`, so `callerSuppliedUserAgent` in the Cloud KMS Data Access audit log shows which calls came through the plugin. The client reports the tag and anyone can send the same string, so it marks the plugin's calls but proves nothing.
