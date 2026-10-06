---
"hardhat-kms": patch
---

Connections created with `hre.network.create({ network, override })` now share the signers of other connections to AWS, Google Cloud and Azure keys, so a key is looked up once per runtime. Before, each connection looked the key up again. Keys that differ in their identifier as written in the config, `region`, `profile`, `endpoint`, `address`, `timeoutMs`, name or display still get their own signers. Keys of third-party providers still get a new signer for each override connection.

Issue: [#105](https://github.com/aelmanaa/hardhat-kms/issues/105)
