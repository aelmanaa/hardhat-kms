---
"hardhat-kms": patch
"@hardhat-kms/aws": patch
"@hardhat-kms/gcp": patch
"@hardhat-kms/azure": patch
---

The package READMEs, which are the npm pages, now say that 0.9.0 is the release candidate for 1.0.0, to use with test keys on testnets. Each one walks through one path: install, configure a key with a `chainId` on its network, run `npx hardhat kms accounts`, pin the printed address, then run `npx hardhat kms accounts --check-sign` to prove the credentials may sign. They state that the `address` pin is optional, and that AWS and Google Cloud keys use their SDK's credential discovery while Azure keys use the plugin's own chain. The three provider READMEs share one structure and no longer say the packages are unpublished. The full "Verify a release" procedure moved to a guide on the docs site; the core README keeps the `npm audit signatures` check and links the guide. Links in the READMEs point at the docs site.

Issue: [#339](https://github.com/aelmanaa/hardhat-kms/issues/339)
