---
"hardhat-kms": patch
---

The `--kms` option's help text no longer implies that Foundry has released an Azure signer. `aws` and `gcp` read Foundry's variables. `azure` reads the names proposed in foundry-rs/foundry#17120, which may change before Foundry ships it.

Issue: [#221](https://github.com/aelmanaa/hardhat-kms/issues/221)
