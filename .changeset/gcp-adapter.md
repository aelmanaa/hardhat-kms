---
"hardhat-kms": minor
"@hardhat-kms/gcp": minor
---

`@hardhat-kms/gcp` is the Google Cloud KMS provider. It signs with the configured key version and refuses a version whose algorithm is not `EC_SIGN_SECP256K1_SHA256`. It checks every request and response with CRC32C and retries a mismatch or an unavailable service at most three times. `hardhat run` exits when the script ends. The package depends on `@google-cloud/kms` 6.2.1 or later and on `google-gax` 6.5.0 or later. `hardhat-kms/provider-utils` now exports `publicKeyFromSpkiPem` and `crc32c`. A `gcp` key without the package fails with the command that installs it.

Issue: [#29](https://github.com/aelmanaa/hardhat-kms/issues/29)
