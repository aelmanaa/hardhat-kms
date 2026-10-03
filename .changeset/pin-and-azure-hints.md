---
"hardhat-kms": patch
"@hardhat-kms/azure": patch
---

Reword four error messages so they no longer point at a change that can make things worse:

- `core.signer.address-mismatch` no longer tells you to update the configuration when a key derives to another address than its pin. It says that nothing was signed, that the key id may name the wrong key or a substituted one, or that the pin may be wrong, and points to the key rotation guide. The error code is unchanged.
- `azure.key.disabled` and `azure.key.no-sign-operation` now print an `az keyvault key set-attributes` command with `--vault-name` (or `--hsm-name`), `--name` and `--version`. Without `--version` the command changes the latest version, which may not be the one the config signs with. A part of the key id read from a configuration variable is shown as `<vault-name>`, `<key-name>` or `<version>`.
- `azure.service.403` now names the two data actions the identity needs on the key, `Microsoft.KeyVault/vaults/keys/read` and `Microsoft.KeyVault/vaults/keys/sign/action`, with Key Vault Crypto User as a built-in alternative, and points to step 2 of the Azure setup guide.
