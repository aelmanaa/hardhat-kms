---
"hardhat-kms": minor
"@hardhat-kms/turnkey": minor
---

Security change. `kms sign --no-hash` now asks at a terminal before it signs a raw digest, and signs only after `y` or `yes`. A raw digest can be the hash of an EIP-7702 authorization, and the plugin cannot tell. Without a terminal, the task signs only for a key with the new `allowRawDigests: true` field and with the new `--yes` flag. `--yes` skips the question only for such a key. A declined or unanswered question fails with `core.task.raw-digest-declined` and makes no sign request. `connection.kms.getAccount(address, { rawSign: true })` now fails with `core.account.raw-sign-not-allowed` unless the key sets `allowRawDigests: true`. Keys given with `--kms` cannot set it, so their raw digests need a terminal. Turnkey sends raw digests and EIP-7702 authorizations as the same `HASH_FUNCTION_NO_OP` request, so a Turnkey policy on authorizations binds only when that request is denied, as the Turnkey setup guide now shows.

What should I do? Add `allowRawDigests: true` to each key in `kms.keys` or `kmsAccounts` that signs raw digests in CI or with `rawSign`, and pass `--yes` to `kms sign --no-hash` where no terminal is attached. Leave it off every other key.

Issue: [#561](https://github.com/aelmanaa/hardhat-kms/issues/561)
