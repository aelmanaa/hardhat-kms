---
"hardhat-kms": minor
---

`kms accounts` gains `--balances` and `--check-sign`. `--balances` shows each address's balance on the `--network` network, in ether in the table and as a decimal wei string in the JSON's `balance` field. It is refused without `--network`. `--check-sign` has each key sign a random EIP-191 message through the normal signer and its signature check, which proves the credentials may sign and not only read the public key. The signature is never printed. The JSON gains `signCheck`, which is `"ok"` or `null`. Both fields appear only with their option, and the report keeps `"version": 1`. A failed balance read or sign check fails only its row, and the command then exits with code 1.

Issue: [#52](https://github.com/aelmanaa/hardhat-kms/issues/52)
