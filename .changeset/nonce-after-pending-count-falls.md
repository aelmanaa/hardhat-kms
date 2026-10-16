---
"hardhat-kms": minor
---

On `edr-simulated` networks, a send from a KMS account without a `nonce` now fills the nonces the node lost after its pending count falls, as after `evm_revert`, `hardhat_reset` or `hardhat_dropTransaction`. A library account's reserved nonce still counts after the fall. A send now takes the lowest nonce at or above the new pending count that no reserved nonce uses and at which the node holds none of the transactions sent on the connection. The plugin asks the node with `eth_getTransactionByHash` about every transaction it recorded at that nonce. A nonce whose lookup fails is skipped.

Before, a reserved nonce or a transaction the node no longer held made the next send skip ahead. That left a nonce gap, and later transactions waited behind it.

What should I do? Nothing. Sends on `http` networks are unchanged.

Issue: [#489](https://github.com/aelmanaa/hardhat-kms/issues/489)
