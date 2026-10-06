---
"hardhat-kms": patch
---

Every error of `hardhat-kms` now has a stable id, a cause and a fix. The new errors reference, `docs/user/reference/errors.md`, lists them. Messages are unchanged. Third-party provider plugins keep building their errors with `kmsError`.

Issue: [#72](https://github.com/aelmanaa/hardhat-kms/issues/72)
