---
"hardhat-kms": minor
---

On a network with `kmsAccounts`, `eth_accounts` and `eth_requestAccounts` now list the network's own accounts followed by the KMS addresses. `eth_sign`, `personal_sign` and `eth_signTypedData_v4` sign with the KMS key, with EIP-191 and strict hex as in Hardhat core. Requests for other addresses pass through. A script exits without closing its connection. Signers are closed 5 seconds after the runtime's last connection closes. `kmsAccounts` on the `default` network prints a warning. An error raised while an adapter is created keeps its message if Hardhat or a plugin raised it, and otherwise shows only its class name.

Issue: [#19](https://github.com/aelmanaa/hardhat-kms/issues/19)
