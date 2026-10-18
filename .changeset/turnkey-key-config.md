---
"hardhat-kms": minor
---

A key with `provider: "turnkey"` now passes config validation. Before, `turnkey` in any case failed with `core.config.provider-reserved`. Its `apiPrivateKey` takes only `configVariable(NAME)`, without a `default` or a `format`: a literal API private key fails validation with `core.config.secret-variable`, and the error never shows the value. `Turnkey`, `turnky` and other near misses of the id fail with `core.config.provider-misspelled`. The configuration reference lists the key's fields.

What should I do? Nothing, unless your code narrows a resolved key on `provider`. `KmsKeyConfig` now includes `TurnkeyKmsKeyConfig`, so code that reads `keyId` from every key that is not a `gcp` key needs a `turnkey` case.

Issue: [#510](https://github.com/aelmanaa/hardhat-kms/issues/510)
