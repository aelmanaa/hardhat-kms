---
"hardhat-kms": patch
---

`eth_sendTransaction`, `eth_signTransaction` and a library account's `signAuthorization` and `signTransaction` now refuse an EIP-7702 authorization from a `--kms` key that is the same KMS key as a config key with `allowedDelegates`, with `core.delegate.command-line-key`. The config key can be in `kms.keys` or in any network's `kmsAccounts`. Before, a connection compared `--kms` keys only with its own network's `kmsAccounts`, so a copy of a listed key from elsewhere in the config signed with no list. An authorization to the zero address still signs, as every list allows it.

Issue: [#593](https://github.com/aelmanaa/hardhat-kms/issues/593)
