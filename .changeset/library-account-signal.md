---
"hardhat-kms": minor
---

`connection.kms.getAccount` takes a `signal` option. When the `AbortSignal` aborts, the account's KMS call in progress stops with `cancelled by the caller's abort signal` and is not retried. After that, every method of the account, and `getAccount` called with the same signal, refuses before any KMS call. A request that already reached the KMS can still be signed there, but the account never returns that signature.

Issue: [#8](https://github.com/aelmanaa/hardhat-kms/issues/8)
