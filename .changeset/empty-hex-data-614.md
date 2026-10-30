---
"hardhat-kms": patch
---

A transaction with `data: "0x"` is now signed with no calldata, and `personal_sign` or `eth_sign` with the message `"0x"` signs the empty message. Before, when the project's `@nomicfoundation/hardhat-zod-utils` used an `@nomicfoundation/hardhat-utils` release older than 5.1.1, the plugin read `"0x"` as one zero byte: it signed calldata `0x00`, so a contract ran its `fallback` function instead of `receive`, or a one-byte message. Which `hardhat-utils` copy is installed depends on the lockfile, so the plugin now decodes these fields itself. `eth_sendTransaction`, `eth_signTransaction` and `kms sign-tx` are fixed.

Issue: [#614](https://github.com/aelmanaa/hardhat-kms/issues/614)
