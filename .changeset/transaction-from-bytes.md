---
"hardhat-kms": patch
---

A request that names a KMS account as 20 bytes, a `Buffer` or a `Uint8Array`, now fails before anything is signed or sent. `eth_signTransaction` and `eth_sendTransaction` refuse such a `from` with `core.tx.from-bytes`. `eth_sign`, `personal_sign` and `eth_signTypedData_v4` refuse such an address with `core.accounts.address-bytes`. Both errors name the account's hex address. A byte array that names another account, or that is not 20 bytes long, goes on to Hardhat unchanged.

What should I do? Pass the address as a 0x-prefixed hex string, for example with viem's `bytesToHex`. viem, ethers and hardhat-ethers already send it that way.

Issue: [#371](https://github.com/aelmanaa/hardhat-kms/issues/371)
