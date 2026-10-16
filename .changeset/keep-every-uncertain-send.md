---
"hardhat-kms": patch
---

A send from a KMS account without a `nonce` no longer reuses the nonce of an earlier transaction that got no answer when a later one, sent with a `nonce` or as a raw transaction, got no answer either. Before, the plugin remembered only the last such transaction on the connection. If the node had the earlier one but its pending count lagged, as behind a load balancer, the next send took that nonce. With higher fees, a Geth node then replaced the earlier transaction without an error.

The plugin now remembers every transaction that got no answer, up to 256 per account and connection, and the next send without a `nonce` asks the node about each of them. A lookup that fails now counts as the node having the transaction, as on `edr-simulated`; before, it counted as not known, and the next send could take the same nonce. Beyond 256, the oldest counts as in the node too. In both cases later sends skip the nonce: at worst a nonce gap, never a reused nonce.

What should I do? Nothing.

Issue: [#506](https://github.com/aelmanaa/hardhat-kms/issues/506)
