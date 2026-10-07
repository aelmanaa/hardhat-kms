---
"hardhat-kms": patch
---

A request that names a KMS account as 20 bytes (a `Buffer` or a `Uint8Array`) instead of a hex string now fails with a clear error before anything is signed:

- `eth_signTransaction` and `eth_sendTransaction` with such a `from` fail with `` `from` must be a hex address string such as 0x…, not a byte array ``. Before, they failed with a raw Hardhat schema error or a node error.
- `eth_sign`, `personal_sign` and `eth_signTypedData_v4` with such an address fail with `the address must be a hex string such as 0x…, not a byte array`. Before, a `Buffer` signed and a `Uint8Array` failed with a raw Hardhat schema error. Hardhat's simulated network refuses a `Buffer` address on these methods too.

A byte array that names another account, or that is not 20 bytes long, goes on to Hardhat unchanged.

What should I do? Pass the address as a 0x-prefixed hex string, for example with viem's `bytesToHex`. viem, ethers and JSON-RPC over HTTP already send it that way.

Issue: [#371](https://github.com/aelmanaa/hardhat-kms/issues/371)
