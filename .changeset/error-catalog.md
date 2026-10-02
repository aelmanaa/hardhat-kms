---
"hardhat-kms": patch
---

Build every error of the core plugin from an error catalogue: each error has a stable id, a message template, a cause and a fix, and the new errors reference, `docs/user/reference/errors.md`, is generated from it. Messages are unchanged. Third-party provider plugins keep building their errors with `kmsError`.
