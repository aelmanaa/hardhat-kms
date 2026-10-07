---
"@hardhat-kms/gcp": patch
---

`kms history` now shows only the sign events of the configured key in its own project. Before, if another project routed its Cloud KMS audit logs into the key's project and had a key with the same location, key ring and name, that key's sign events showed in the history too. The Cloud Logging filter now names the key's project, whether `keyVersionName` gives it by id or by number.

What should I do? Nothing.

Issue: [#390](https://github.com/aelmanaa/hardhat-kms/issues/390)
