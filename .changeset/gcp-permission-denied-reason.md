---
"@hardhat-kms/gcp": patch
---

A Google Cloud KMS call refused with PERMISSION_DENIED now says when the Cloud KMS API is not enabled. The error `gcp.status.service-disabled` gives the `gcloud services enable cloudkms.googleapis.com` command for the key's project. A quota project the credentials cannot use now fails with `gcp.status.quota-project`, which names the reason, `USER_PROJECT_DENIED` or `CONSUMER_INVALID`, and how to change the quota project. The plugin reads only the reason from Google's answer. Every other PERMISSION_DENIED keeps the hint to grant the key's roles.

Issue: [#639](https://github.com/aelmanaa/hardhat-kms/issues/639)
