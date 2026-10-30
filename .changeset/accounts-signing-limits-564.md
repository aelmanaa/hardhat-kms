---
"hardhat-kms": minor
---

`kms accounts` now shows what each key may delegate its account to with an EIP-7702 authorization. When any listed key has `allowedDelegates`, a `DELEGATES` column shows `any`, `revoke only` (an empty list, which allows only the zero address) or `N listed`, and `--json` adds `allowedDelegates`, the number of entries, to those keys. A key with `allowRawDigests: true` gets a line under its row saying so, and `allowRawDigests: true` in the JSON. Entries for one KMS key that differ in either setting are no longer merged into one row. The configuration reference now says how to lock a deployer or admin key against any delegation with `allowedDelegates: []`, and the key rotation guide how to retire authorizations a key signed that nobody sent.

Issue: [#564](https://github.com/aelmanaa/hardhat-kms/issues/564)
