---
"hardhat-kms": patch
---

`kms sign-tx` no longer repeats part of a file that is not JSON in its error. The JSON parser's message quoted the text around the error, so passing a `.env` file by mistake printed the start of a secret. The error now names only the line and column, for example `the transaction file .env is not valid JSON at line 1, column 1`.

`kms sign --data --from-file` and `kms verify --data --from-file` had the same problem with a large integer: the error quoted about 16 digits of it. It now names the key instead, for example `a number at key "chainId" is above 2^53 - 1`.

Two other signing errors changed:

- A provider plugin that returns a signature as `{ r, s }` with values that are not `bigint`, such as JavaScript numbers, now gets `r and s must be bigints` in the signer's `invalid signature` error, after one fresh request. Before, a high `s` ended in a `TypeError`.
- When the EIP-712 encoder refuses typed data, the error cuts the encoder's message, which can quote a whole value, to 200 characters ending in `...`.

What should I do? Nothing.

Issue: [#436](https://github.com/aelmanaa/hardhat-kms/issues/436)
