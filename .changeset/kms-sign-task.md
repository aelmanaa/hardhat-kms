---
"hardhat-kms": minor
---

Add `kms sign <key> <message>`, which prints a 65-byte `r || s || v` signature as `cast wallet sign` does. A `0x` message is signed as bytes and anything else as UTF-8 text, both with the EIP-191 prefix. `--data` signs EIP-712 typed data given as JSON, or read from a file with `--from-file`. When the typed data names a chain, it must match `--chain` or the `--network` connection's chain unless `--allow-cross-chain` or `kms.allowCrossChainTypedData` is set. `--no-hash` signs a raw 32-byte digest, prints a warning to standard error, and refuses any other length; no RPC method offers it. Every signature must recover to the key before it is printed.
