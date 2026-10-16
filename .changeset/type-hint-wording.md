---
"hardhat-kms": patch
---

The `core.tx.type-mismatch` message now names only the fields the request sets. For example, `type: "0x4"` with `maxFeePerGas` and `maxPriorityFeePerGas` now says "Add an authorizationList, or remove type.", and `type: "0x0"` with `gasPrice` and an `accessList` says "Remove accessList, or remove type.". A `null` `gasPrice`, `maxFeePerGas`, `maxPriorityFeePerGas`, `accessList` or `authorizationList` in `eth_sendTransaction` or `eth_signTransaction` now fails with `core.tx.null-field`, which names the field, before any request to the node. Before, it failed with a raw schema error.

Issue: [#504](https://github.com/aelmanaa/hardhat-kms/issues/504)
