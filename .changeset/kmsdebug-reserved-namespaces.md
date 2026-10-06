---
"hardhat-kms": patch
---

`kmsDebug` from `hardhat-kms/provider-utils` now refuses the namespaces hardhat-kms logs under, which are `account`, `config`, `history`, `providers`, `rpc` and `signer`. A reserved or malformed namespace throws a `HardhatPluginError` that names the namespace and the rule, `core.provider.debug-namespace-reserved` or `core.provider.debug-namespace-invalid`. Before, it threw a plain `Error` that asked for a bug report.

What should I do? Log under your provider id, such as `kmsDebug("myvault")`. A namespace has at most 64 characters.

Issue: [#257](https://github.com/aelmanaa/hardhat-kms/issues/257)
