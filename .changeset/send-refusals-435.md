---
"hardhat-kms": patch
---

KMS transaction signing now refuses a self-authorization whose nonce or chain does not match the final transaction. The RPC send path also refuses `type: "0x3"` and `maxFeePerBlobGas`. EIP-7702 requests whose automatic fee estimation fails report that EIP-1559 fees are needed.

What should I do? Set the transaction nonce explicitly before signing a self-authorization. Use that nonce plus 1 for the first self-authorization and consecutive nonces for additional ones. If fee history is unavailable, set both `maxFeePerGas` and `maxPriorityFeePerGas`.

Issue: [#435](https://github.com/aelmanaa/hardhat-kms/issues/435)
