---
"hardhat-kms": patch
---

A key whose `provider` is `turnkey` or `fireblocks` now fails config validation with `core.config.provider-reserved`, and the message links the issue that tracks the planned provider. These ids are reserved for providers that hardhat-kms will ship, so a third-party plugin can no longer serve keys under them.
