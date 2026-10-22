---
"hardhat-kms": minor
---

Security change. `kms sign-auth` now shows what an EIP-7702 authorization does and asks before it signs. With `--network` it reads the account's nonce and code and the delegate's code and ERC-1967 slot, and the question shows the account, the delegate with its `allowedDelegates` label, the chain (`ALL CHAINS` for chain 0), the nonce against the account's nonce, the delegate's code size and hash, and the account's current delegation. At a terminal only `y` or `yes` signs; any other answer or closed input fails with `core.task.auth-declined` and exits non-zero. The new `--yes` skips the question, but only for a delegate in the key's `allowedDelegates` or the zero address. Without a terminal the task signs only with `--yes` and such a delegate; a key without `allowedDelegates`, which includes every `--kms` key, can then only revoke. `--force` still allows chain 0 and does not skip the question. The task now refuses authorizations that cannot apply: a nonce the account has passed, a delegate that is itself delegated, a precompile delegate, and an account with contract code. It warns about a nonce far ahead, a `--nonce` a pending transaction will likely use first, a re-delegation, a proxy delegate and a delegate without code. With `--network` the task now always connects to the node.

What should I do? Add the delegate to the key's `allowedDelegates` and pass `--yes` in CI. To sign without a node, use `--chain` with `--nonce`.

Issue: [#563](https://github.com/aelmanaa/hardhat-kms/issues/563)
