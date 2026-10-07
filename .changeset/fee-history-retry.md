---
"hardhat-kms": patch
---

A failed `eth_feeHistory` no longer makes every later KMS transaction on the connection legacy. With `gasPrice: "auto"`, the plugin asks `eth_feeHistory` a second time when the first request fails or gives an answer it cannot read. If the second fails too, only that transaction gets a legacy gas price, and the next transaction asks again. A request that times out is not asked a second time. A node that answers that it has no `eth_feeHistory` method (JSON-RPC code -32601) gets legacy gas prices for the rest of the connection, as with Hardhat. Hardhat's own local accounts still switch to legacy for the rest of the connection after any failure.

Issue: [#395](https://github.com/aelmanaa/hardhat-kms/issues/395)
