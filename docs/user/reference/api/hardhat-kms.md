# hardhat-kms

The hardhat-kms plugin, as the default export. Importing it also adds the `kms` config section
and each network's `kmsAccounts` to Hardhat's config types.

## Variables

### default

> `const` **default**: `HardhatPlugin`

The hardhat-kms plugin: sign transactions, messages and typed data with keys held in AWS KMS,
Google Cloud KMS and Azure Key Vault or Managed HSM.

Add it to the `plugins` array of your Hardhat config.
