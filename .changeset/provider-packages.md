---
"hardhat-kms": minor
---

Each cloud provider's adapter now lives in its own package. `hardhat-kms` keeps the key formats and signing checks and depends on no cloud SDK. The new `hardhat-kms/provider-utils` entry point exports the helpers provider plugins build on.

What should I do? Install the provider package next to `hardhat-kms`: `@hardhat-kms/aws` for an `aws` key, `@hardhat-kms/gcp` for a `gcp` key and `@hardhat-kms/azure` for an `azure` key. Without it, the key fails with the command that installs it.

Issue: [#91](https://github.com/aelmanaa/hardhat-kms/issues/91)
