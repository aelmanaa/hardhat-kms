---
"hardhat-kms": minor
---

Add `kms verify`, which checks that an address signed a message or, with `--data [--from-file]`, EIP-712 typed data. The expected signer is `--address`, checked without contacting the KMS, or `--key`, whose address the KMS returns. The message, `--data` and `--from-file` work as in `cast wallet verify` and `kms sign`, and signatures are read as cast reads them: `v` may be 0, 1, 27, 28 or an EIP-155 value, and a high-S signature is accepted with a note that OpenZeppelin's `ECDSA.recover` rejects it. A match prints one line and exits with code 0; a mismatch prints both addresses and exits with code 1. There is no `--no-hash`.
