---
"hardhat-kms": patch
---

The `core.tx.type-mismatch` message now names only the fields the request sets. For example, `type: "0x4"` with `maxFeePerGas` and `maxPriorityFeePerGas` now says "Add an authorizationList, or remove type.", and `type: "0x0"` with `gasPrice` and an `accessList` says "Remove accessList, or remove type.". A `null` `gasPrice`, `maxFeePerGas`, `maxPriorityFeePerGas`, `accessList` or `authorizationList` in `eth_sendTransaction` or `eth_signTransaction` now fails with `core.tx.null-field`, which names the field, before any request to the node. Before, it failed with a raw schema error. With automatic fees (the default), a lone `null` `maxFeePerGas` or `maxPriorityFeePerGas`, with no `gasPrice` and the other EIP-1559 field left out, is still filled like an absent field, as Hardhat does. Requests whose numeric `type` contradicts their fee fields once such a `null` is filled, which signed before, now fail with `core.tx.type-mismatch`, as they do with a value in place of the `null`. For example, `type: "0x0"` with `maxFeePerGas: null` was signed as type 2, and `type: "0x2"` with `maxFeePerGas: null` and an `authorizationList` was signed as type 4.

Issue: [#504](https://github.com/aelmanaa/hardhat-kms/issues/504)
