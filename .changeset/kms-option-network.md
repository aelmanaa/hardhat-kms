---
"hardhat-kms": minor
---

Add `--kms` keys to the selected network: the `--network` value, or `default` without one. They come after the network's `kmsAccounts`, and a command-line key that names the same KMS key as a config key on that network is an error that names both, without the value.
