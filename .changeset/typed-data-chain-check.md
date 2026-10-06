---
"hardhat-kms": minor
---

The plugin now refuses typed data whose `domain.chainId` differs from the connected chain. Typed data without `domain.chainId` is still signed, as MetaMask, Hardhat and Foundry do. The chain id is read once per connection and must match the network config's `chainId` when one is set.

What should I do? To sign typed data for another chain on purpose, set `kms.allowCrossChainTypedData` to `true`.

Issue: [#20](https://github.com/aelmanaa/hardhat-kms/issues/20)
