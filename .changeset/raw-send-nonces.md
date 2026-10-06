---
"hardhat-kms": minor
---

A `connection.kms.getAccount` account now has a viem `nonceManager`. Its sends and the plugin's own sends from the same account get distinct nonces. A client whose transport is `custom(connection.provider)` sends in order with the plugin's sends. A client with its own transport, such as `http(url)`, reserves its nonce for 60 seconds and prints a warning that the broadcast is not ordered. No RPC answer is rewritten, and raw transactions from other senders pass on untouched. A library send started from inside a send from the same account fails at once with `core.account.nonce-reentrant`. A send that waits 5 seconds behind a library send prints a warning, and another prints when the 60-second limit ends a hold. The viem peer range is now `^2.55.13`. `getAccount` refuses an older viem with `core.account.viem-too-old` before any KMS call. `core.account.viem-missing` no longer names a package manager. The warning printed on the first transaction a library account signs is gone.

What should I do? If your project pins viem to an exact version below 2.55.13, such as `"viem": "2.47.6"`, bump it to 2.55.13 or later. With an older pin, npm stops the install with `ERESOLVE`, and pnpm and Yarn install it with a peer warning and `getAccount` then refuses it. On an automining node, a plugin send can be refused with "Nonce too high" while a client with its own transport signs or broadcasts its reserved nonce. Send through `custom(connection.provider)`, or wait for that send's receipt first.

Issue: [#186](https://github.com/aelmanaa/hardhat-kms/issues/186)
