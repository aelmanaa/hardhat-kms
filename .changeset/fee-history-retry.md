---
"hardhat-kms": patch
---

A failed `eth_feeHistory` no longer makes every later KMS transaction on the connection legacy. With `gasPrice: "auto"`, the filler retries `eth_feeHistory` once. If both reads fail or give an answer it cannot read, only that transaction falls back to a legacy gas price; the next one asks again. Hardhat's own local accounts still keep the fallback for the whole connection.

Issue: [#395](https://github.com/aelmanaa/hardhat-kms/issues/395)
