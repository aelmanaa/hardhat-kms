---
"hardhat-kms": minor
---

`kms sign-auth <key> <delegate>` signs an EIP-7702 authorization and prints it as the JSON tuple an `eth_sendTransaction` `authorizationList` takes. The chain comes from `--chain` or `--network`, which cannot be combined. The nonce comes from `--nonce` or from the `--network` node's pending count. `--self-broadcast` adds one for a key that also sends the transaction, and cannot be combined with `--nonce`. Chain 0 needs `--force`. Before the KMS call, a line on standard error names the authority, chain, nonce and delegate, and with `--network` the task warns when the delegate has no code on the node. The tuple must recover to the key, with a low `s`, before it is printed.

Issue: [#35](https://github.com/aelmanaa/hardhat-kms/issues/35)
