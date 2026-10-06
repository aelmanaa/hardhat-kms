---
"hardhat-kms": patch
"@hardhat-kms/azure": patch
---

`core.signer.address-mismatch`, `azure.key.disabled`, `azure.key.no-sign-operation` and `azure.service.403` have new fix texts. Error codes are unchanged.

`core.signer.address-mismatch` no longer suggests updating the configuration when a key derives to another address than its pin. It says that nothing was signed, that the key id may name the wrong key or a substituted one, or that the pin may be wrong, and points to the key rotation guide.

`azure.key.disabled` and `azure.key.no-sign-operation` now print an `az keyvault key set-attributes` command with `--vault-name` or `--hsm-name`, `--name` and `--version`. Before, the command had no `--version`. A part of the key id read from a configuration variable is shown as `<vault-name>`, `<key-name>` or `<version>`. For an unversioned key id, the version is the one Key Vault returned. The fix text adds that the command needs the keys/update permission and, for a vault in another Azure cloud, `az cloud set`.

`azure.service.403` now names the two data actions the identity needs on the key, `Microsoft.KeyVault/vaults/keys/read` and `Microsoft.KeyVault/vaults/keys/sign/action`, with Key Vault Crypto User as a built-in alternative, and points to step 2 of the Azure setup guide.

Issues: [#215](https://github.com/aelmanaa/hardhat-kms/issues/215), [#223](https://github.com/aelmanaa/hardhat-kms/issues/223)
