---
"@hardhat-kms/gcp": patch
---

A Google Cloud key version that Cloud KMS refuses with FAILED_PRECONDITION now shows its state, such as `DISABLED`, `DESTROY_SCHEDULED` or `DESTROYED`. A version still in `PENDING_GENERATION` gets its own message, which says to retry in a minute. A 4xx answer that is not a Google error, such as a proxy's HTML page, now shows its HTTP status and says something other than Google Cloud KMS refused the request. Both used to read as a disabled, destroyed or scheduled-for-destruction key version.

Issue: [#642](https://github.com/aelmanaa/hardhat-kms/issues/642)
