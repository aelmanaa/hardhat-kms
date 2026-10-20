---
"hardhat-kms": minor
---

Security change. `kms sign --no-hash` now asks at a terminal before it signs a raw digest, and signs only after `y` or `yes`. A raw digest can be the hash of an EIP-7702 authorization, and the plugin cannot tell. Without a terminal, the task signs only for a key with the new `allowRawDigests: true` field and with the new `--yes` flag. `--yes` skips the question only for such a key. A declined or unanswered question fails with `core.task.raw-digest-declined` and makes no sign request. `connection.kms.getAccount(address, { rawSign: true })` now fails with `core.account.raw-sign-not-allowed` unless the key sets `allowRawDigests: true`. Keys given with `--kms` cannot set it, so their raw digests need a terminal.

What should I do? Add `allowRawDigests: true` to each key in `kms.keys` or `kmsAccounts` that signs raw digests in CI or with `rawSign`, and pass `--yes` to `kms sign --no-hash` where no terminal is attached. Leave it off every other key.

Issue: [#561](https://github.com/aelmanaa/hardhat-kms/issues/561)
