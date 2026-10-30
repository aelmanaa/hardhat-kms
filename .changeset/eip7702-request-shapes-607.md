---
"hardhat-kms": patch
---

`eth_sendTransaction`, `eth_signTransaction` and `kms sign-tx` now refuse an `authorizationList` that is not an array, an item of it that is not an object, and a `to` beside it that is not a 20-byte hex address, before the fee and gas requests, with `core.tx.authorization-list-not-array`, `core.tx.authorization-not-object` and `core.tx.authorization-to-not-address`. Before, such a request reached the node's fee and gas requests and then failed with a schema error. `kms sign-tx` refuses them, and `authorizationList: null`, before it opens the key.

Issue: [#607](https://github.com/aelmanaa/hardhat-kms/issues/607)
