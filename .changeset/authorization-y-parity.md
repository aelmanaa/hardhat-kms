---
"hardhat-kms": minor
---

`signAuthorization` on the account from `connection.kms.getAccount` no longer returns `v`, which viem marks as deprecated. The result has `address`, `chainId`, `nonce`, `r`, `s` and `yParity`, and is still viem's `SignedAuthorization`. An authorization list entry with `v` and no `yParity` still signs. The signature bytes do not change.

What should I do? Code that read `v` from the result should read `yParity`.

Issue: [#249](https://github.com/aelmanaa/hardhat-kms/issues/249)
