---
"hardhat-kms": patch
---

`hardhat-kms` now accepts `@nomicfoundation/hardhat-utils` 5 as well as 4 (`^4.3.0 || ^5.0.0`), so a project on Hardhat 3.20 or later can install one copy of it instead of both majors. The `@nomicfoundation/hardhat-zod-utils` floor rises from 3.0.5 to 3.0.7, since earlier releases have no `type` in the transaction request schema that `kms sign-tx` and the transaction filler read. The `@nomicfoundation/hardhat-errors` range stays `^3.1.0`. Each floor, both majors of `hardhat-utils` included, is now tested before every release.

Issue: [#587](https://github.com/aelmanaa/hardhat-kms/issues/587)
