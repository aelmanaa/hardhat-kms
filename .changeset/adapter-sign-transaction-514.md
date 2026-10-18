---
"hardhat-kms": minor
---

Provider adapters can now implement `signTransaction`. The plugin calls it for every transaction from `eth_sendTransaction`, `eth_signTransaction`, a library account's `signTransaction` and `kms sign-tx`. It receives the unsigned serialized transaction, its digest, its type and its chain id, and returns only the signature. The plugin checks that signature against its own digest and the key, and sends or prints its own transaction. Adapters without `signTransaction` keep signing transactions through `signDigest`. EIP-7702 authorizations, `kms sign-auth` and `kms sign --no-hash` still go to `signDigest`.

What should I do? Nothing, unless you maintain a provider plugin whose adapter already has a method named `signTransaction`. The provider contract has reserved that name since 1.0. Such an adapter now receives every transaction through it, so rename the method or make it follow the contract.

Issue: [#514](https://github.com/aelmanaa/hardhat-kms/issues/514)
