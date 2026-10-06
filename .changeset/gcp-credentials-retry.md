---
"@hardhat-kms/gcp": patch
---

A failed credentials lookup no longer stays for the life of the signer. The next call looks the credentials up again. Before, after one failure, such as a metadata server that did not answer in time, every later call failed with the same error. The failing call still reports the same `gcp.connect.*` error. A credentials file that appears after a failure is picked up, and the SDK no longer prints the earlier failure with the file's path when the client closes.

Issue: [#195](https://github.com/aelmanaa/hardhat-kms/issues/195)
