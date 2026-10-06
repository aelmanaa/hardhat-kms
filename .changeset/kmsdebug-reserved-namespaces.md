---
"hardhat-kms": patch
---

`kmsDebug` from `hardhat-kms/provider-utils` now refuses the namespaces hardhat-kms logs under, which are `account`, `config`, `history`, `providers`, `rpc` and `signer`, so a provider package's debug lines cannot pass for the core's. A reserved or malformed namespace throws a `HardhatPluginError` that names the namespace and the rule, `core.provider.debug-namespace-reserved` or `core.provider.debug-namespace-invalid`. Before, it threw a plain `Error` that asked you to report a bug in hardhat-kms.

What should I do? A provider package logs under its provider id, such as `kmsDebug("myvault")`, of at most 64 characters.

Issue: [#257](https://github.com/aelmanaa/hardhat-kms/issues/257)
