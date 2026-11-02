---
"@hardhat-kms/azure": minor
---

The Azure adapter now refuses a Key Vault or Managed HSM key that is exportable or has a release policy. It fails before any signature with `azure.key.exportable` or `azure.key.release-policy`. Key Vault's release operation can hand the private key of such a key to an environment the policy accepts. The check reads the key the adapter already fetches and sends no extra request.

What should I do? Nothing, unless your key was created with `--exportable` or `--policy`. Such a key cannot be made non-exportable. Create a new key without those options, as step 1 of the Azure setup guide shows, configure it, and move any funds from the old address.

Issue: [#636](https://github.com/aelmanaa/hardhat-kms/issues/636)
