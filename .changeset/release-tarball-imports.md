---
---

Fix the release tarball checker’s startup in the publishing jobs. Its package-list import loaded `yaml` through a test-install helper, although those jobs install no workspace dependencies, so staging stopped before any npm call. The checker now imports a dependency-free package list. The tarball checks and release approvals are unchanged.

Issue: [#463](https://github.com/aelmanaa/hardhat-kms/issues/463)
