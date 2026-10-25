---
"hardhat-kms": patch
---

`eth_sendTransaction` and `eth_signTransaction` from a KMS account accept a `type` such as `2`, `"0x02"`, `"0X2"` or `"2"` again. With `@nomicfoundation/hardhat-zod-utils` 3.0.7 or later, which a fresh install of any Hardhat 3 release gets, these requests failed with a raw schema error and nothing was signed. Hardhat's own local accounts refuse these forms. A request that also goes to a Hardhat account should send `type` as a `0x` quantity without leading zeros, such as `"0x2"`.

Issue: [#585](https://github.com/aelmanaa/hardhat-kms/issues/585)
