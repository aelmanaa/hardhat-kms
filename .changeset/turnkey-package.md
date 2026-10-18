---
"hardhat-kms": minor
"@hardhat-kms/turnkey": minor
---

The new package `@hardhat-kms/turnkey` signs with the `turnkey` keys of a `kms` config. It calls Turnkey's API with the key's API key and has no runtime dependencies. Transactions and EIP-7702 authorizations reach Turnkey as a 32-byte digest. Messages reach Turnkey as the EIP-191 message, which Turnkey hashes with Keccak-256. Typed data reaches Turnkey as EIP-712 JSON. A key whose Turnkey policy needs an approval fails at once, and the error names the pending activity to reject. After a rate limit, a server error or no answer, the plugin sends the request again with the same body, so Turnkey signs it once. Errors show Turnkey's HTTP status and error code, never its message.

`kms accounts` now lists two Turnkey keys that name the same organization and address once.

Issue: [#511](https://github.com/aelmanaa/hardhat-kms/issues/511)
