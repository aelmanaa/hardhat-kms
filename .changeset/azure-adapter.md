---
"hardhat-kms": minor
"hardhat-kms-azure": minor
---

Add the Azure Key Vault provider as its own package, `hardhat-kms-azure`. It reads the key's JWK and checks that it is an enabled `EC` or `EC-HSM` key on `P-256K` that may sign, pins the key version on first use, signs with `ES256K` against that version, and refuses a signature whose `kid` names another version. Credentials come from a service principal, workload identity, `az`, `azd`, then a managed identity with a 10-second limit and a 3-second timeout on each request. It depends on `@azure/keyvault-keys` 4.10.2, `@azure/identity` 4.13.3 and `@azure/core-rest-pipeline` 1.25.0 or later. `hardhat-kms/provider-utils` now exports `publicKeyFromJwk` and `parseAzureKeyId`, and an `azure` key without the package fails with the command that installs it.
