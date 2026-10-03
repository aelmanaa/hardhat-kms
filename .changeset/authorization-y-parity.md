---
"hardhat-kms": minor
---

Drop `v` from what `signAuthorization` returns on the account from `connection.kms.getAccount`, because viem marks `v` on signatures as deprecated. The result has `address`, `chainId`, `nonce`, `r`, `s` and `yParity`, and is still viem's `SignedAuthorization`. An authorization list entry that has `v` and no `yParity` still signs. The signature does not change.
