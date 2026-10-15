---
"hardhat-kms": patch
---

`eth_sendTransaction` and `eth_signTransaction` from a KMS account now estimate gas at the `pending` block. A self-sponsored EIP-7702 transaction could be signed with too little gas and run out of gas. This happened when the account had another transaction pending, or when a load-balanced RPC answered from a node a block behind. When a node refuses the `pending` tag, the plugin estimates again without it.

Issue: [#492](https://github.com/aelmanaa/hardhat-kms/issues/492)
