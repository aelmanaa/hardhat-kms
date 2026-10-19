---
"hardhat-kms": patch
"@hardhat-kms/turnkey": patch
---

A Turnkey key whose `apiPrivateKey` or `organizationId` variable is not set now fails with Hardhat's own error, which names the variable, for example `HHE7: Configuration Variable "TURNKEY_API_PRIVATE_KEY" not found`. Before, `kms sign`, `kms accounts --check-sign` and a send failed with `the provider call failed (HardhatError)`, which did not say which variable was missing. The error names the variable, never a value. The signer now passes any error from Hardhat on unchanged, as adapter creation already did; AWS, Google Cloud and Azure keys read their variables when the adapter is created, so their errors do not change.

What should I do? Nothing. If a Turnkey key fails with the HHE7 error, set the variable it names in the environment or in `hardhat-keystore`.

Issue: [#544](https://github.com/aelmanaa/hardhat-kms/issues/544)
