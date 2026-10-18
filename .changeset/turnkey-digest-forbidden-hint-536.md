---
"@hardhat-kms/turnkey": patch
---

A 403 on a digest now says what the request sent: `(a digest, sent with HASH_FUNCTION_NO_OP and PAYLOAD_ENCODING_HEXADECIMAL: a policy that allows only SIGN_TRANSACTION, or only HASH_FUNCTION_KECCAK256, denies it)`. A digest is an EIP-7702 authorization, `kms sign --no-hash`, or a transaction of a key with `transactionSigning: "digest"`. Before, the `turnkey.service.forbidden` message gave no hint for them.

Issue: [#536](https://github.com/aelmanaa/hardhat-kms/issues/536)
