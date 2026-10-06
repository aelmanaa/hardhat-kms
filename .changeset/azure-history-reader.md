---
"@hardhat-kms/azure": minor
---

`kms history` now reads Azure keys. It lists the key's `KeySign` events from the `AZKVAuditLogs` table of the Log Analytics workspace set in `kms.audit.azure.workspaceId`. A diagnostic setting on the vault must send the `AuditEvent` category to that workspace in resource-specific mode. The reader matches the key by vault host and key name, for every version. The request id is Key Vault's `CorrelationId`. The digest is not logged. Reading needs query access to the workspace, such as the Log Analytics Data Reader role. A missing setting, a workspace without the table, and a refused or throttled read each fail with their own error. Managed HSM keys and vaults outside Azure's public cloud are not supported yet and fail with their own error. The query loads only when `kms history` reads an Azure key.

Issue: [#126](https://github.com/aelmanaa/hardhat-kms/issues/126)
