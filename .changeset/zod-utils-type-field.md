---
"hardhat-kms": patch
---

`eth_sendTransaction` and `eth_signTransaction` from a KMS account accept a numeric `type` in every form again with `@nomicfoundation/hardhat-zod-utils` 3.0.7 or later, which Hardhat 3.19 and 3.20 install. 3.0.7 adds `type` to Hardhat's request schema as a `0x` quantity without leading zeros, and the plugin passed the request's `type` to the schema, so `type: 2`, `"0x02"`, `"2"`, `"0X2"` or `"legacy"` failed with a raw schema error before anything was signed. The plugin reads `type` itself and now leaves it out of the copy it checks with the schema, so these requests are filled and checked as before. Hardhat's own local accounts refuse these forms from 3.19; the plugin keeps accepting them.

Issue: [#580](https://github.com/aelmanaa/hardhat-kms/pull/580)
