---
"@hardhat-kms/gcp": patch
---

A `GOOGLE_APPLICATION_CREDENTIALS` file that cannot be read, or missing Application Default Credentials, now fails with the new `gcp.connect.credentials-file` error, which leaves out the file's path. Before, the process crashed with an unhandled rejection after the task reported its error. `kms history` reports the same error and no longer retries it as a network error.

Issue: [#191](https://github.com/aelmanaa/hardhat-kms/issues/191)
