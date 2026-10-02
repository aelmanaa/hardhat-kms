---
"hardhat-kms-gcp": patch
---

A `GOOGLE_APPLICATION_CREDENTIALS` file that cannot be read, or missing Application Default Credentials, no longer crashes the process with an unhandled rejection after the task reports its error. The adapter initializes the Cloud KMS client before each call, so the credentials failure is handled there. Both the adapter and `kms history` now report an unreadable credentials file with the new `gcp.connect.credentials-file` error, which leaves out the file's path, and `kms history` no longer retries that failure as a network error.
