---
"@hardhat-kms/azure": patch
---

The Azure adapter now refuses a Key Vault response whose `kid` names another vault than the configured one. The check covers the key lookup and each sign response. A mismatch fails with `azure.response.key`. Before, it compared only the key name and version, so a response for a key with the same name and version in another vault passed. The host comparison ignores letter case, for Key Vault and Managed HSM hosts.

Issue: [#329](https://github.com/aelmanaa/hardhat-kms/issues/329)
