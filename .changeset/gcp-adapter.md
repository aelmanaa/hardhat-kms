---
"hardhat-kms": minor
"hardhat-kms-gcp": minor
---

Add the Google Cloud KMS provider as its own package, `hardhat-kms-gcp`. It signs with the configured key version, refuses versions whose algorithm is not `EC_SIGN_SECP256K1_SHA256`, and checks every request and response with CRC32C, retrying a mismatch or an unavailable service at most three times; the SDK's own retries are off. It uses the SDK's REST transport, so `hardhat run` exits when the script ends, and depends on `@google-cloud/kms` 6.2.1 or later and on `google-gax` 6.5.0 or later, the first release that enforces request deadlines over REST. `hardhat-kms/provider-utils` now also exports `publicKeyFromSpkiPem` and `crc32c`, and a `gcp` key without the package fails with the command that installs it.
