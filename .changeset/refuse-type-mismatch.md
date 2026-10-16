---
"hardhat-kms": minor
---

`eth_sendTransaction` and `eth_signTransaction` from a KMS account now refuse a `type` they cannot sign as written, before any request to the node. A request that sets `gasPrice`, `maxFeePerGas` or `maxPriorityFeePerGas` and a `type` those fields contradict fails with `core.tx.type-mismatch`; before, it was signed as the type the fields give. For example, `type: "0x2"` with `gasPrice` was signed as legacy, `type: "0x0"` with `maxFeePerGas` as EIP-1559, and `type: "0x4"` without an `authorizationList` as EIP-1559. The message says what to change: set the fee fields of the type you ask for, add an `authorizationList` for type 4, or remove `type`. `type: "0x1"` with `gasPrice` and no `accessList`, as viem's `eip2930` and ethers' `type: 1` send it, is now signed as an EIP-2930 transaction with an empty access list instead of as legacy. A numeric `type` other than 0 to 4 now fails with `core.tx.unsupported-type` instead of being ignored, for example Celo's fee-currency type `0x7b` or zkSync's `0x71`, which were signed as plain transactions without their chain-specific fields. A `type` with no fee field, such as viem's `type: "legacy"` without fees, signs as before.

Issue: [#496](https://github.com/aelmanaa/hardhat-kms/issues/496)
