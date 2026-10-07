---
"hardhat-kms": patch
---

The provider contract in `hardhat-kms/types` is stable from 1.0. It covers `KmsKeyAdapter`, `SignContext`, `KeyDescription`, `SignatureOutput`, `TypedData`, the resolved key types, the provider config interfaces, the `kms.audit` config, the `kms` hook and the history reader types. A minor release may add optional members to them, a method to the `kms` hook, or a built-in provider. Changing or removing a member needs a major. `hardhat-kms/provider-utils` stays experimental and may change in a minor.

Issues: [#292](https://github.com/aelmanaa/hardhat-kms/issues/292), [#333](https://github.com/aelmanaa/hardhat-kms/issues/333)
