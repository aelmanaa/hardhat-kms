---
"@hardhat-kms/azure": minor
---

Add the Azure reader for `kms history`. It lists a key's `KeySign` events from the `AZKVAuditLogs` table of the Log Analytics workspace set in `kms.audit.azure.workspaceId`, which a diagnostic setting on the vault must send the `AuditEvent` category to in resource-specific mode. It matches the key by vault host and key name, for every version, in one query through the Log Analytics query API. The request id is Key Vault's `CorrelationId`, the `x-ms-request-id` it returned to the caller; the digest is not logged. Reading needs query access to the workspace, such as the Log Analytics Data Reader role. A missing setting, a workspace without the table, a refused or throttled read, and Managed HSM keys and vaults outside Azure's public cloud, which are not supported yet, each fail with their own error. The query goes through `@azure/core-rest-pipeline`, which the package already installs, and loads only when `kms history` reads an Azure key.
