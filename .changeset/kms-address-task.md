---
"hardhat-kms": minor
---

Add the `kms` task namespace with `kms address <key>`, which prints a key's EIP-55 address, and `kms public-key <key>`, which prints its 65-byte uncompressed public key. A task names a key by its name in `kms.keys`, as `<network>.kmsAccounts[<index>]` for an inline key, or by the variable a `--kms` key was read from, such as `AWS_KMS_KEY_ID`. An unknown name fails with the known names, and an `address` pin that does not match the key fails with both addresses. Each run closes its KMS clients, so the command exits once it has printed.
