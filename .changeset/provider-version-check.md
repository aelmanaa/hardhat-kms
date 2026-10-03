---
"hardhat-kms": minor
"@hardhat-kms/aws": minor
---

Require the same version of `hardhat-kms` and `@hardhat-kms/aws`. The peer dependency is now exact, so npm refuses a mismatched install, and the first AWS key fails with both versions and the install command when pnpm or Yarn installed one anyway.
