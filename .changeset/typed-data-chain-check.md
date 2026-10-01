---
"hardhat-kms": minor
---

Refuse typed data whose `domain.chainId` differs from the connected chain, unless `kms.allowCrossChainTypedData` is `true`. Typed data without `domain.chainId` is still signed, as MetaMask, Hardhat and Foundry do. The chain id is read once per connection and must match the network config's `chainId` when one is set.
