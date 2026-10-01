---
"hardhat-kms": minor
---

Add `kms sign-auth <key> <delegate>`, which signs an EIP-7702 authorization and prints it as the JSON tuple an `eth_sendTransaction` `authorizationList` takes. The chain comes from `--chain` or `--network`, which cannot be combined. The nonce comes from `--nonce`, or from the `--network` node's pending count, plus one with `--self-broadcast` for a key that also sends the transaction; `--nonce` and `--self-broadcast` cannot be combined. Chain 0 needs `--force`. Before the KMS call, a line on standard error names the authority, chain, nonce and delegate. With `--network`, the task warns when the delegate has no code on the node. The tuple must recover to the key, with a low `s`, before it is printed.
