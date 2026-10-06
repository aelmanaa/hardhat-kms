---
"hardhat-kms": minor
---

`kms history <key>` lists a key's sign events from its provider's audit log, newest first, with `--since`, `--until`, `--limit`, `--json` and `--show-ids`. The plugin stores nothing and fills in nothing. Fields the provider never logs are listed in `notLogged`, an empty result says that logging is not confirmed, and a recent or old range gets a note. The config gains `kms.audit.azure.workspaceId`. Provider plugins add readers through the new `readSignHistory` method of the `kms` hook, and `hardhat-kms/provider-utils` exports `auditLogAccessDenied` and `auditLogThrottled` for them. The AWS, Google Cloud and Azure readers ship in their packages.

Issue: [#126](https://github.com/aelmanaa/hardhat-kms/issues/126)
