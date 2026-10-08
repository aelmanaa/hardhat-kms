---
"hardhat-kms": patch
---

Two sends from the same KMS key could take the same nonce, so the node kept only one of them. This could happen to code that keeps using a `connection.kms.getAccount` account after its connection is closed, while another connection sends from the same key. viem calls the account's `nonceManager.reset` when a send fails, even when the account refused to give it a nonce, and that reset released the send lock that the other connection's send was holding. The account now ignores the `reset` that follows a nonce it refused, and a reset only releases the lock for a send of its own connection. A reset owed by a send whose broadcast failed is now counted for that send's connection only, so a reset through another connection cannot use it up.

What should I do? Nothing. An account still refuses to send once its connection is closed; call `getAccount` on an open connection to send again.

Issue: [#416](https://github.com/aelmanaa/hardhat-kms/issues/416)
