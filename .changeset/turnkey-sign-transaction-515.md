---
"@hardhat-kms/turnkey": minor
"hardhat-kms": minor
---

Turnkey keys sign transactions through Turnkey's `sign_transaction` activity (`ACTIVITY_TYPE_SIGN_TRANSACTION_V2`). Turnkey parses the transaction, so its policies can read the transaction's fields (`eth.tx.*`): a policy can limit a key to one contract, one chain or a value. The plugin decodes the signed transaction Turnkey returns, refuses it unless its type and every field equal the transaction it sent (`turnkey.sign.transaction-mismatch`), and keeps only the signature. It sends its own transaction, never Turnkey's bytes. Messages, typed data, EIP-7702 authorizations, `kms sign-auth` and `kms sign --no-hash` go through `sign_raw_payload`.

A Turnkey key takes an optional field, `transactionSigning`: `"transaction"`, the default, or `"digest"`, which signs each transaction's hash through `sign_raw_payload` with `HASH_FUNCTION_NO_OP`, as Foundry does. The core validates it and resolves it to `"transaction"` when unset.

What should I do? Nothing. When a key and its Turnkey policy are shared with Foundry and the policy allows only `SIGN_RAW_PAYLOAD`, set `transactionSigning: "digest"` on the key, or add the second policy of the Turnkey setup guide, which allows `SIGN_TRANSACTION`.

Issue: [#515](https://github.com/aelmanaa/hardhat-kms/issues/515)
