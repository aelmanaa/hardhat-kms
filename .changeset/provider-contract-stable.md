---
"hardhat-kms": patch
---

The provider contract in `hardhat-kms/types` is no longer marked experimental: `KmsKeyAdapter`, `SignContext`, `KeyDescription`, the `kms` hook and the history reader types are stable from 1.0. A minor release may add optional members to them; changing or removing a member needs a major. `hardhat-kms/provider-utils` stays experimental. The API reference shows the change.

Issue: [#333](https://github.com/aelmanaa/hardhat-kms/issues/333)
