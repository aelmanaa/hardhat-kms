---
"@hardhat-kms/gcp": minor
---

`kms history` now reads Google Cloud keys. It lists every `AsymmetricSign` entry on any version of the key from the Data Access audit log of the key's project, with the principal, source IP, user agent, key version and digest as logged. Cloud Audit Logs records no request id, so each entry shows its `insertId`. The read needs Data Access logs turned on for Cloud KMS and `roles/logging.privateLogViewer`. The setup guide has a new "Audit logs" section on both. `google-auth-library` `^11.0.0` is now a direct dependency and loads only when `kms history` reads a Google Cloud key.

Issue: [#126](https://github.com/aelmanaa/hardhat-kms/issues/126)
