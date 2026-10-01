---
"hardhat-kms": minor
---

Add `kms sign-tx <key> <tx.json>`, the equivalent of `cast mktx`. It reads a transaction with `eth_sendTransaction` field names from a JSON file, fills it on the `--network` node as `eth_signTransaction` does for a KMS account, signs it with the key, and prints the raw signed transaction on standard output, as `cast mktx` does, and its hash on standard error. It never sends the transaction. `--network` is required. The task refuses, before the KMS signs, a `from` that is not the key's address, a `chainId` for another chain, blob transactions, a `type` the fields do not give, a mixed-case address with a wrong EIP-55 checksum, a quantity that is not `0x` hex, and fields that `eth_sendTransaction` does not have, such as `gasLimit` or `input`.
