---
"hardhat-kms": patch
---

`kms history` on a Turnkey key fails with `core.history.unsupported`, which says that the task does not read Turnkey keys yet. The message names neither the organization id nor the key's address. A key of AWS KMS, Google Cloud KMS or Azure Key Vault whose provider package is missing still gets `core.history.no-reader-builtin`.

What should I do? Nothing. Read a Turnkey key's activities in the Turnkey dashboard, or with Turnkey's `list_activities` query.

Issue: [#524](https://github.com/aelmanaa/hardhat-kms/issues/524)
