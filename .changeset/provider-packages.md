---
"hardhat-kms": minor
---

Each cloud provider's adapter now lives in its own package. `hardhat-kms` keeps the key formats and signing checks and depends on no cloud SDK. The new `hardhat-kms/provider-utils` entry point exports the helpers provider plugins build on.

What should I do? Install `@hardhat-kms/aws` next to `hardhat-kms` for an `aws` key. Without it, the key fails with the command that installs it.

Issue: [#91](https://github.com/aelmanaa/hardhat-kms/issues/91)
