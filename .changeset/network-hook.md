---
"hardhat-kms": minor
---

Add the network hook. On a network with `kmsAccounts`, `eth_accounts` and `eth_requestAccounts` list the network's own accounts followed by the KMS addresses, and `eth_sign`, `personal_sign` and `eth_signTypedData_v4` sign with the KMS key, with EIP-191 and strict hex as in Hardhat core. Requests for other addresses pass through. `eth_sendTransaction` and `eth_signTransaction` from a KMS account fail until transactions are supported. Signers are shared by the connections of a runtime and closed 5 s after the last one closes, so a script exits without closing its connection. `kmsAccounts` on the `default` network prints a warning, and an error raised while an adapter is created keeps its message if Hardhat or a plugin raised it, and otherwise shows only its class name.
