---
"@hardhat-kms/turnkey": minor
---

Turnkey keys now sign transactions through Turnkey's `sign_transaction` activity (`ACTIVITY_TYPE_SIGN_TRANSACTION_V2`), not as a 32-byte digest. Turnkey parses the transaction, so its policies can read the transaction's fields (`eth.tx.*`): a policy can limit a key to one contract, one chain or a value. The plugin decodes the signed transaction Turnkey returns, refuses it unless its type and every field equal the transaction it sent (`turnkey.sign.transaction-mismatch`), and keeps only the signature. It still sends its own transaction, never Turnkey's bytes. Messages, typed data, EIP-7702 authorizations and `kms sign --no-hash` still go through `sign_raw_payload`, as before.

What should I do? Check that a Turnkey policy allows `SIGN_TRANSACTION` for the API user and the wallet account. The second policy in the Turnkey setup guide already does. A policy that allows only `SIGN_RAW_PAYLOAD` now refuses every transaction with `turnkey.service.forbidden`, and the message names `ACTIVITY_TYPE_SIGN_TRANSACTION_V2`. Add the guide's second policy to fix it. A transaction's Turnkey activity now holds the signed transaction, which anyone who can read the activity can broadcast. Reject any pending activity the plugin gave up on.

Issue: [#515](https://github.com/aelmanaa/hardhat-kms/issues/515)
