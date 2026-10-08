---
"@hardhat-kms/gcp": patch
---

`kms history` for Google Cloud now shows only the configured key's sign events. Before, if another project routed its Cloud KMS audit logs into the key's project and had a key with the same location, key ring and name, that key's sign events showed in the history too. This holds whether `keyVersionName` names the project by id or by number.

What should I do? Nothing.

Issue: [#390](https://github.com/aelmanaa/hardhat-kms/issues/390)
