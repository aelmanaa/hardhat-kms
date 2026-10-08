---
"hardhat-kms": minor
---

`connection.kms.getAccount` now takes a `signal` option. When the `AbortSignal` aborts, the account's KMS call in flight is aborted and rejects with `cancelled by the caller's abort signal`, and the plugin does not retry it. Every later call of the account, `getAccount` included, is refused before any KMS call. A request that already reached the KMS can still be signed there, but the account never returns that signature.

Issue: [#8](https://github.com/aelmanaa/hardhat-kms/issues/8)
