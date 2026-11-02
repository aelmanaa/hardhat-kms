---
"hardhat-kms": patch
---

`hardhat-kms/provider-utils` exports `kmsKeyAddress`, which returns the address of a key a task names without printing it, and `confirm`, `isYes`, `processTerminal` and the `Terminal` type, which ask a person at the terminal before a key signs. They are experimental and are for the first-party packages, such as `@hardhat-kms/safe`. The package description and keywords now mention Safe proposals.

Issue: [#653](https://github.com/aelmanaa/hardhat-kms/issues/653)
