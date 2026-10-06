---
"hardhat-kms": minor
---

KMS accounts now sign transactions. `eth_sendTransaction` fills the transaction as Hardhat does for a local account, signs it with the KMS key and sends it as `eth_sendRawTransaction`. `eth_signTransaction` returns the signed transaction without sending it. Legacy with EIP-155, EIP-2930, EIP-1559 and EIP-7702 transactions are supported, with the same bytes Hardhat's local accounts produce. A transaction without `from` gets the sender Hardhat would give it, and is signed when that sender is a KMS account. A pre-signed EIP-7702 authorization with a high-S or unrecoverable signature prints a warning.

Issue: [#24](https://github.com/aelmanaa/hardhat-kms/issues/24)
