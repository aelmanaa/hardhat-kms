---
"hardhat-kms": minor
---

Add `kms history <key>`, which lists a key's sign events from its provider's audit log, newest first, with `--since`, `--until`, `--limit`, `--json` and `--show-ids`. The plugin stores nothing and fills in nothing: fields the provider never logs are listed in `notLogged`, an empty result says that logging is not confirmed, and recent or old ranges get a note. Provider plugins add readers through a new `kms` hook method, `readSignHistory`, and `hardhat-kms/provider-utils` exports `auditLogAccessDenied` and `auditLogThrottled` for them. The config gains `kms.audit.azure.workspaceId`. The AWS, Google Cloud and Azure readers follow in their packages.
