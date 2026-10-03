---
"hardhat-kms": patch
---

`kmsDebug` from `hardhat-kms/provider-utils` now refuses the namespaces hardhat-kms logs under (`account`, `config`, `history`, `providers`, `rpc` and `signer`), so a provider package's debug lines cannot pass for the core's. A provider package logs under its provider id, such as `kmsDebug("myvault")`. A reserved or malformed namespace now throws a `HardhatPluginError` that names the namespace and the rule (`core.provider.debug-namespace-reserved` or `core.provider.debug-namespace-invalid`), instead of a plain `Error` that asked you to report a bug in hardhat-kms.
