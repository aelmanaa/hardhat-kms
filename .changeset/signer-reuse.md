---
"hardhat-kms": patch
---

Connections created with `hre.network.create({ network, override })` now share the signers of other connections to AWS, Google Cloud and Azure keys, so a key is looked up once per runtime rather than once per connection. Keys that differ in their identifier, `region`, `profile`, `endpoint`, `address`, `timeoutMs` or name still get their own signers. Keys of third-party providers still get a new signer for each override connection.
