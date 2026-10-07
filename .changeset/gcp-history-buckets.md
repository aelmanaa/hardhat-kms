---
"@hardhat-kms/gcp": patch
---

The `kms history` setup hint for Google Cloud no longer says that a sink to another bucket keeps sign entries out. A read of the key's project returns entries from every log bucket that stores them, as the `entries.list` reference documents. The hint now names what does keep them out: no sink storing them in a log bucket, or a sink that sends them only to BigQuery, Cloud Storage or Pub/Sub.

Issue: [#369](https://github.com/aelmanaa/hardhat-kms/issues/369)
