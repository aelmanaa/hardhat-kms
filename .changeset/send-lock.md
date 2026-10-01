---
"hardhat-kms": minor
---

Send from one KMS account one transaction at a time. `eth_sendTransaction` calls from one KMS account on one chain run in turn, so parallel sends get consecutive nonces; other accounts and chains do not wait, and `eth_signTransaction` never waits. On http networks, a send without a `nonce` gets at least one more than the highest nonce the node accepted from that account on the connection, even when the node's pending count lags. A node's error answer to a broadcast, such as a revert, comes back unchanged. When no answer comes back, `eth_sendTransaction` fails with JSON-RPC error -32000 and the transaction hash in `transactionHash` and `data.hash`. The same request sent again on the same connection within 120 seconds then sends the same signed transaction again instead of a new one.
