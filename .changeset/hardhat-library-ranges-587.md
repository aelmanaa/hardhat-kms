---
"hardhat-kms": patch
---

A transaction request with `data: "0x"` is now always signed with no calldata. `@nomicfoundation/hardhat-zod-utils` 3.0.7 and earlier read `"0x"` as one zero byte, through `@nomicfoundation/hardhat-utils` 4, so with such a copy installed the plugin signed a transaction whose calldata was `0x00`. A contract then ran its `fallback` function instead of `receive`. Hardhat's own signer read the request the same way with that copy. The `hardhat-zod-utils` floor rises from 3.0.5 to 3.0.8, the first release on `hardhat-utils` 5, which reads `"0x"` as empty.

`hardhat-kms` also accepts `@nomicfoundation/hardhat-utils` 5 as well as 4 (`^4.3.0 || ^5.0.0`), so a project on Hardhat 3.20 or later can install one copy of it instead of both majors. The `@nomicfoundation/hardhat-errors` range stays `^3.1.0`. Each floor, both majors of `hardhat-utils` included, is now tested before every release.

Issue: [#587](https://github.com/aelmanaa/hardhat-kms/issues/587)
