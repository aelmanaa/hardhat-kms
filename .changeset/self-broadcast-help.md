---
"hardhat-kms": patch
---

The `kms sign-auth --self-broadcast` help now says that the task sends nothing. The flag signs the authorization for the pending nonce + 1, for when the same key sends the transaction that carries it. Before, the help said that the key also sends that transaction. The new help text is "Sign for the pending nonce + 1, for when this key sends the transaction that carries the authorization. The task sends nothing".

Issue: [#338](https://github.com/aelmanaa/hardhat-kms/issues/338)
