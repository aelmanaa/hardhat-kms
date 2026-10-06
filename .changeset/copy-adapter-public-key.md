---
"hardhat-kms": patch
---

A provider that changes a byte array after returning or receiving it can no longer change which public key a signature is checked against, or the caller's message or typed data. A provider that returns something other than a byte array as its public key now fails with the key-material error, "expected a 65-byte uncompressed public key". Before, it failed as a provider call.

Issue: [#172](https://github.com/aelmanaa/hardhat-kms/issues/172)
