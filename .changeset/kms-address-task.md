---
"hardhat-kms": minor
---

The new `kms` task namespace has `kms address <key>`, which prints a key's EIP-55 address, and `kms public-key <key>`, which prints its 65-byte uncompressed public key. A task names a key by its name in `kms.keys`, as `<network>.kmsAccounts[<index>]` for an inline key, or by the variable a `--kms` key was read from, such as `AWS_KMS_KEY_ID`. An unknown name fails with the known names and suggests one that differs only in case. An `address` pin that does not match the key fails with both addresses. Standard output holds only the result. Provider status messages go to standard error. Each run closes its KMS clients, so the command exits once it has printed.

Issue: [#33](https://github.com/aelmanaa/hardhat-kms/issues/33)
