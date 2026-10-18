---
"hardhat-kms": minor
"@hardhat-kms/turnkey": minor
---

A Turnkey transaction that times out, or that a library account's `signal` aborts, after its request reached Turnkey no longer lets the plugin sign its nonce again. Turnkey keeps working on an activity it accepted, and a completed `sign_transaction` activity holds the signed transaction, which every user of the organization can read and broadcast. Before, the next send took the same nonce, so two valid transactions could exist for it. Now the error, `core.signer.transaction-outstanding`, names the nonce and the activity id, and the network connection's later sends from the account skip that nonce: a gap, never a duplicate. The hold covers `eth_sendTransaction`, `eth_signTransaction` and a library account's `signTransaction`, and ends when a transaction with the nonce reaches the node through the connection, or when the connection closes. A key with `transactionSigning: "digest"`, a request that failed before it left, and AWS, Google Cloud and Azure keys release the nonce as before.

Provider plugins get two optional members: `KmsKeyAdapter.signTransactionOutlivesAbort`, for a provider that may still sign a transaction after the plugin gave up on it, and `SignContext.requestSent`, which such an adapter calls when its request may have reached the provider. `@hardhat-kms/turnkey` sets the flag for keys that sign with `sign_transaction`.

What should I do? If a Turnkey send fails with `core.signer.transaction-outstanding`, open the activity the message names in the Turnkey dashboard before you send anything else from the account. Reject it while it is pending, or send a replacement transaction with the nonce the message names. If you maintain a provider plugin, nothing changes unless your provider keeps signing a transaction after the call aborts and stores the result where others can broadcast it; then set `signTransactionOutlivesAbort` and call `ctx.requestSent`, as the provider guide describes.

Issue: [#537](https://github.com/aelmanaa/hardhat-kms/issues/537)
