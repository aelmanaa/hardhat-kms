---
"hardhat-kms": patch
---

`eth_signTransaction` and `eth_sendTransaction` now refuse a `from` that names a KMS account as 20 bytes (a `Buffer` or a `Uint8Array`) with a clear error, `` `from` must be a hex address string such as 0x…, not a byte array ``. Before, the request failed with a raw Hardhat schema error or a node error. Nothing is signed or sent in either case.

What should I do? Pass `from` as a 0x-prefixed hex string, for example with viem's `bytesToHex`. viem, ethers and JSON-RPC over HTTP already send it that way.

Issue: [#371](https://github.com/aelmanaa/hardhat-kms/issues/371)
