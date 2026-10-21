---
"hardhat-kms": minor
---

A key can now set `allowedDelegates` to limit the contracts it may delegate its account to with an EIP-7702 authorization. Each entry has an `address`, the `chains` it is allowed on or `"all"`, and an optional `label` and `codeHash`. `kms sign-auth`, a library account's `signAuthorization`, and a transaction that carries the key's own authorization refuse any other delegate before the KMS signs. A chain-0 authorization matches only entries with `chains: "all"`. With `codeHash`, the plugin reads the delegate's code from the network and refuses a mismatch. The zero address always passes. No flag overrides the list. Keys without `allowedDelegates` work as before.

Issue: [#562](https://github.com/aelmanaa/hardhat-kms/issues/562)
