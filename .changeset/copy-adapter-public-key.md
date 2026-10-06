---
"hardhat-kms": patch
---

The signer now copies the public key a provider returns and checks every later signature against that copy. Each signing call gives the provider its own copy of the digest, the message bytes or the typed data. A provider that changes an array it returned or received can no longer change what a signature is checked against, or the caller's message or typed data. A provider that returns something other than a byte array as its public key now fails with the key-material error, "expected a 65-byte uncompressed public key". Before, it failed as a provider call.

Issue: [#172](https://github.com/aelmanaa/hardhat-kms/issues/172)
