---
"hardhat-kms": minor
---

Move each cloud provider's adapter into its own package. `hardhat-kms` keeps the key formats and signing checks and depends on no cloud SDK. Using an `aws` key without `hardhat-kms-aws` fails with the command that installs it. The new `hardhat-kms/provider-utils` entry point exports the helpers provider plugins build on.
