---
"hardhat-kms": minor
"@hardhat-kms/gcp": minor
---

A Google Cloud key takes an optional `protectionLevel`, such as `"HSM"`. The plugin then refuses to sign with a key version at another protection level, or one whose public key response names no level. The check runs before the first signature and fails with `gcp.key.protection-level`. Accepted values are `SOFTWARE`, `HSM`, `HSM_SINGLE_TENANT`, `EXTERNAL` and `EXTERNAL_VPC`. Any other value fails when the config loads with `core.config.gcp-protection-level`.

`kms accounts` shows the level that Cloud KMS reports for each Google Cloud key in a new `PROTECTION` column, and in `protectionLevel` in its JSON output, with or without the setting. The `hardhat:kms:gcp` debug namespace logs it too. Provider adapters can report a level through a new optional `protectionLevel()` method.

Issue: [#637](https://github.com/aelmanaa/hardhat-kms/issues/637)
