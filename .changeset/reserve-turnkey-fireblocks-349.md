---
"hardhat-kms": patch
---

A key whose `provider` is `turnkey` or `fireblocks`, in any case, now fails config validation with `core.config.provider-reserved`. The message links the issue that tracks the planned provider. The core also refuses to build an adapter for such a key. A third-party plugin's `kms` handler never receives one.

What should I do? Nothing, unless a third-party plugin serves keys under `turnkey` or `fireblocks`. Give that plugin's provider another id, and change the `provider` of its keys to match.

Issue: [#349](https://github.com/aelmanaa/hardhat-kms/issues/349)
