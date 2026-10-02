---
"hardhat-kms": patch
---

Keep a copy of the public key a provider returns, made as soon as the key passes its curve check. Every later signature is checked against that copy, so a provider that changes or shrinks the array it returned can no longer change the key that signatures are checked against.
