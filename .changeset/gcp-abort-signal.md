---
"@hardhat-kms/gcp": patch
---

A Google Cloud KMS call that times out or is abandoned now cancels its request, as the AWS and Azure plugins do, instead of leaving it to run until its deadline. The plugin passes the call's abort signal to the Cloud KMS client, which cancels with google-gax 6.15.0 or later; a new install resolves it, and an older google-gax ignores the signal as before.

Issue: [#651](https://github.com/aelmanaa/hardhat-kms/issues/651)
