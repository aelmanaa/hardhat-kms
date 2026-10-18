---
"hardhat-kms": patch
---

A Turnkey key's `transactionSigning` now decides which signer it gets. Before, a connection whose config override changed only `transactionSigning` shared the first connection's signer, so the override was ignored without an error: a key overridden to `"digest"` still signed through `sign_transaction`, and the reverse. `kms accounts` now lists Turnkey keys for one account as one entry only when they use the same API keys and the same `transactionSigning`, so `--check-sign` checks each API user.

Issue: [#536](https://github.com/aelmanaa/hardhat-kms/issues/536)
