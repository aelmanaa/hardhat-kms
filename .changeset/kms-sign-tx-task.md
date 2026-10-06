---
"hardhat-kms": minor
---

`kms sign-tx <key> <tx.json>` fills and signs a transaction without sending it, as `cast mktx` does. It reads a transaction with `eth_sendTransaction` field names from a JSON file and fills it on the `--network` node as `eth_signTransaction` does for a KMS account. It prints the raw signed transaction on standard output and its hash on standard error. `--network` is required. Before the KMS signs, the task refuses a `from` that is not the key's address, a `chainId` for another chain, a blob transaction, a `type` the fields do not give, a mixed-case address with a wrong EIP-55 checksum, a quantity that is not `0x` hex, and a field that `eth_sendTransaction` does not have, such as `gasLimit` or `input`.

Issue: [#36](https://github.com/aelmanaa/hardhat-kms/issues/36)
