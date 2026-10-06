---
"hardhat-kms": minor
"@hardhat-kms/aws": minor
---

`hardhat-kms` and each provider package, `@hardhat-kms/aws`, `@hardhat-kms/gcp` and `@hardhat-kms/azure`, now require each other at the same version. The peer dependency is exact, so npm refuses a mismatched install. When pnpm or Yarn installed a mismatch anyway, the first key of that provider fails with both versions and the install command.

What should I do? Upgrade `hardhat-kms` and every `@hardhat-kms/*` package together.

Issue: [#95](https://github.com/aelmanaa/hardhat-kms/issues/95)
