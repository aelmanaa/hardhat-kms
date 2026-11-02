---
"@hardhat-kms/azure": patch
---

A 403 from Key Vault shows Key Vault's inner error code after the status when it has one, for example `Key Vault answered 403 Forbidden/ForbiddenByRbac`, and the message's hint follows it: `ForbiddenByRbac` asks for a role assignment, `AccessDenied` for the access policy's `get` and `sign` permissions, and `ForbiddenByFirewall` for the vault's network rules. The other 403 messages also name a suspended or disabled subscription and give the `az rest` command that reads the subscription's live state, since `az account show` reads a cache. The error messages from Key Vault are still never shown.
