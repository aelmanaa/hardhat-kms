---
"hardhat-kms": patch
---

`eth_sendTransaction`, `eth_signTransaction` and `kms sign-tx` now refuse an `authorizationList` without `to`, and an empty `authorizationList`, before any request to the node, with `core.tx.authorization-no-to` and `core.tx.authorization-list-empty`. `kms sign-tx` refuses them before it opens the key. Before, such a request failed late with micro-eth-signer's `fields had validation errors`, or at `eth_estimateGas` with the node's message. Any other field micro-eth-signer refuses now fails with `core.tx.invalid-fields`, which names each field and its reason.

Issue: [#586](https://github.com/aelmanaa/hardhat-kms/issues/586)
