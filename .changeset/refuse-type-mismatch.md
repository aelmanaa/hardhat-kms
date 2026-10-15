---
"hardhat-kms": minor
---

`eth_sendTransaction` and `eth_signTransaction` from a KMS account now refuse a `type` they cannot sign as written, before any request to the node. A request that sets `gasPrice`, `maxFeePerGas` or `maxPriorityFeePerGas` and a `type` those fields contradict fails with `core.tx.type-mismatch`; before, it was signed as the type the fields give. For example, `type: "0x2"` with `gasPrice` was signed as legacy, `type: "0x0"` with `maxFeePerGas` as EIP-1559, `type: "0x1"` with `gasPrice` and no `accessList` as legacy, and `type: "0x4"` without an `authorizationList` as EIP-1559. A numeric `type` other than 0 to 4, such as `0x7e`, now fails with `core.tx.unsupported-type` instead of being ignored. To fix a refused request, set the fee fields of the type you ask for, add `accessList: []` for type 1, or remove `type`. A `type` with no fee field, such as viem's `type: "legacy"` without fees, signs as before.

Issue: [#496](https://github.com/aelmanaa/hardhat-kms/issues/496)
