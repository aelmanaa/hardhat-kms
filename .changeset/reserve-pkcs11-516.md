---
"hardhat-kms": patch
---

A key whose `provider` is `pkcs11`, in any case, now fails config validation with `core.config.provider-reserved`. The message links the issue that tracks the planned PKCS#11 provider. The core also refuses to build an adapter for such a key. A third-party plugin's `kms` handler never receives one.

What should I do? Nothing, unless a third-party plugin serves keys under `pkcs11`. Give that plugin's provider another id, and change the `provider` of its keys to match.

Issue: [#516](https://github.com/aelmanaa/hardhat-kms/issues/516)
