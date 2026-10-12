---
"hardhat-kms": patch
---

The ethers example no longer installs TypeChain. It tests deployment and contract calls through ethers' ABI-based API. Its README explains that TypeChain remains an option for users' projects and is included in Hardhat's Ethers+Mocha toolbox. The example's dependency tree no longer includes glob 7 or inflight.

Issue: [#460](https://github.com/aelmanaa/hardhat-kms/issues/460), [#461](https://github.com/aelmanaa/hardhat-kms/issues/461)
