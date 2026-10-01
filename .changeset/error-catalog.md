---
"hardhat-kms": patch
---

Build every error of the core plugin from an error catalogue: each error has a stable id, a message template, a cause and a fix, and the new errors reference, `docs/user/reference/errors.md`, is generated from it. Messages are unchanged. `hardhat-kms/provider-utils` also exports the catalogue helpers `catalogError`, `catalogMessage` and `internalError`, with the `ErrorEntry`, `ErrorKind`, `TemplateParams` and `TemplateValue` types, so provider plugins can build their errors the same way.
