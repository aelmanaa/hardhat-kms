---
"hardhat-kms": minor
---

A key with `provider: "turnkey"` now passes config validation. It needs `organizationId`, a UUID written as a literal or as `configVariable(...)`, and `address`, the address of the Turnkey wallet account. It also needs `apiPrivateKey` as `configVariable(NAME)`, without a `default` or a `format`. A literal API private key fails validation with `core.config.secret-variable`, and the error never shows the value. An optional `apiPublicKey` takes a literal or `configVariable(...)`. Unknown fields fail, as for the other built-in providers. `@hardhat-kms/turnkey` signs with these keys. `Turnkey`, `turnky` and other near misses of the id now fail with `core.config.provider-misspelled`. Before, `turnkey` in any case failed with `core.config.provider-reserved`.

What should I do? Nothing, unless your code narrows a resolved key on `provider`. `KmsKeyConfig` now includes `TurnkeyKmsKeyConfig`, so code that reads `keyId` from every key that is not a `gcp` key needs a `turnkey` case.

Issue: [#510](https://github.com/aelmanaa/hardhat-kms/issues/510)
