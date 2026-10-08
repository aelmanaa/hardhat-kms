---
"hardhat-kms": patch
---

A send through the plugin could sign the same nonce as a `connection.kms.getAccount` send from the same KMS key. If its fees were high enough, the node then replaced the library transaction whose hash viem had already returned; otherwise one of the two failed. Four cases did this:

- The library transaction went out through a second connection. That connection learned its nonce, but the account's own connection did not, so with a node that reports a lagging pending count, the next send there took the same nonce. The account's connection now records the outcome too, including a broadcast that got no answer.
- The library send took longer than 60 s to broadcast. The plugin released the nonce, and the send waiting behind it took it. The plugin now keeps that nonce from its own sends for up to 60 s more, and the warning no longer says that the node refuses one of the two transactions.
- A transaction from the same account and with the same nonce, but signed for another chain, released the nonce. It now passes on unchanged.
- The library transaction went out through a connection to the same chain that has no KMS keys. The plugin did not see it, so its sends waited up to 60 s and could then take the same nonce. Such a connection now ends the wait while a library send holds a nonce.

What should I do? In most cases, nothing. One case needs action: a library send that takes over 60 s and then fails before its transaction reaches the node leaves its nonce unused, while the plugin's later sends from that connection have taken higher nonces. On a live node those later transactions are not mined until the gap is filled. A warning now names the nonce. viem also resets after a timeout, when the node may have the transaction, so first check the node for that nonce, as in [Look the transaction up](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/uncertain-sends.md#2-look-the-transaction-up). If no transaction has it, fill the gap by sending a transaction with that `nonce`, as in [Fill a gap or replace a transaction](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/uncertain-sends.md#4-fill-a-gap-or-replace-a-transaction). Sending a `getAccount` account through `custom(connection.provider)` of its own connection remains the recommended setup.

Issue: [#433](https://github.com/aelmanaa/hardhat-kms/issues/433)
