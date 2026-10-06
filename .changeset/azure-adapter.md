---
"hardhat-kms": minor
"@hardhat-kms/azure": minor
---

`@hardhat-kms/azure` adds the Azure Key Vault provider as its own package. It checks that the key is an enabled `EC` or `EC-HSM` key on `P-256K` that may sign, pins the key version on first use and signs with `ES256K` against that version. A signature whose `kid` names another version is refused. Credentials come from a service principal, workload identity, `az`, `azd`, then a managed identity, with a 10-second limit and a 3-second timeout on each request. The package depends on `@azure/keyvault-keys` 4.10.2, `@azure/identity` 4.13.3 and `@azure/core-rest-pipeline` 1.25.0 or later. `hardhat-kms/provider-utils` now exports `publicKeyFromJwk` and `parseAzureKeyId`. An `azure` key without the package fails with the command that installs it.

Issue: [#30](https://github.com/aelmanaa/hardhat-kms/issues/30)
