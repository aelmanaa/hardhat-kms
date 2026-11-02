---
"hardhat-kms": patch
---

`hardhat-kms/provider-utils` exports `catalogWarning`, which prints a `warning` entry of an error catalogue on standard error after `hardhat-kms: `. The errors reference lists warnings with the kind `warning`. The helper is for the first-party provider packages.

Issue: [#635](https://github.com/aelmanaa/hardhat-kms/issues/635)
