---
"hardhat-kms": patch
---

Keep the signer's data apart from the provider's. The signer copies the public key a provider returns before its curve check, and checks every later signature against that copy. Each signing call gives the provider its own copy of the digest, the message bytes or the typed data. A provider that changes or shrinks an array it returned, or changes what it received, can no longer change what a signature is checked against, or the caller's message or typed data. A provider that returns something other than a byte array as its public key now fails with the key-material error, "expected a 65-byte uncompressed public key", instead of a failed provider call.
