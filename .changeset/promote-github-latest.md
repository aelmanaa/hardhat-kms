---
"hardhat-kms": patch
---

Promotion to npm `latest` now also marks the GitHub release as Latest when the optional fork-test job is skipped. Previously, a promotion using a Sepolia proof could leave the GitHub release marked as a prerelease after all four npm tags moved successfully.

Issue: [#455](https://github.com/aelmanaa/hardhat-kms/issues/455)
