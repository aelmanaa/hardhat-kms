---
"hardhat-kms": minor
---

`kms sign <key> <message>` prints a 65-byte `r || s || v` signature, as `cast wallet sign` does. A `0x` message is signed as bytes and anything else as UTF-8 text, both with the EIP-191 prefix. `--data` signs EIP-712 typed data given as JSON, or read from a file with `--from-file`. Typed data that names a chain must match `--chain` or the `--network` chain, which cannot be combined, unless `--allow-cross-chain` or `kms.allowCrossChainTypedData` is set. The `--network` chain is the config's `chainId`, else the node's. `--no-hash` signs a raw 32-byte digest, prints a warning to standard error and refuses any other length. No RPC method offers it. Every signature must recover to the key before it is printed.

Issue: [#34](https://github.com/aelmanaa/hardhat-kms/issues/34)
