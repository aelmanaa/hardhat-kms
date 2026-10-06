---
"hardhat-kms": minor
---

`--kms` keys now join the selected network, which is the `--network` value or `default` without one. They come after the network's `kmsAccounts`. A command-line key that names the same KMS key as a config key on that network fails with an error that names both, without the value.

Issue: [#84](https://github.com/aelmanaa/hardhat-kms/issues/84)
