---
"hardhat-kms": patch
---

The `kms sign-auth --self-broadcast` help now says what the flag does: it signs for the pending nonce + 1, for when the same key will send the transaction that carries the authorization. The task sends nothing.

Issue: [#338](https://github.com/aelmanaa/hardhat-kms/issues/338)
