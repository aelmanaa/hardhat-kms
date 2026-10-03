---
"@hardhat-kms/gcp": minor
---

Read a Google Cloud key's sign history for `kms history` from Cloud Audit Logs. The reader lists every `AsymmetricSign` entry on any version of the key in the Data Access audit log of the key's project, through Cloud Logging's `entries.list`, with the principal, source IP, user agent, key version and digest as logged. Cloud Audit Logs records no request id, so each entry's `insertId` is shown instead. The read needs Data Access logs on for Cloud KMS and `roles/logging.privateLogViewer`, and the setup guide has a new "Audit logs" section on both. `google-auth-library` `^11.0.0`, which `google-gax` already installs, is now a direct dependency; it loads only when `kms history` reads a Google Cloud key.
