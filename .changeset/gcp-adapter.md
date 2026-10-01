---
"hardhat-kms": minor
"hardhat-kms-gcp": minor
---

Add the Google Cloud KMS provider as its own package, `hardhat-kms-gcp`. It signs with the configured key version, refuses versions whose algorithm is not `EC_SIGN_SECP256K1_SHA256`, and checks every request and response with CRC32C, retrying a mismatch at most three times. It uses the SDK's REST transport, so `hardhat run` exits when the script ends, and depends on `@google-cloud/kms` 6.2.1 or later. `hardhat-kms/provider-utils` now also exports `publicKeyFromSpkiPem` and `crc32c`, and a `gcp` key without the package fails with the command that installs it.
