---
"@hardhat-kms/gcp": patch
---

The `kms history` setup hint for Google Cloud no longer says that a sink to another bucket keeps sign entries out. A read of the key's project covers every log bucket that stores them, as the `entries.list` reference documents, provided the identity can read that bucket. The hint now names what keeps them out: no sink storing them in a log bucket, a sink that sends them only to BigQuery, Cloud Storage or Pub/Sub, or a bucket the identity cannot read.

Issue: [#369](https://github.com/aelmanaa/hardhat-kms/issues/369)
