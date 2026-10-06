---
"hardhat-kms": minor
---

`kms accounts` lists the KMS keys with their provider, source, key id and address, and checks each key against the KMS and its `address` pin. Every key is tried. A key that fails is shown with its error, and the command then exits with code 1. A pin that does not match prints both addresses. A key without a pin gets an `address` line to paste into its config. With `--network`, the task lists that network's keys. Without it, every key is listed once. Key ids read from configuration variables are masked unless `--show-ids` is given. `--json` prints the list as JSON with `"version": 1`. The JSON types, `AccountsReport` and `AccountEntry`, are exported from `hardhat-kms/types`.

Issue: [#32](https://github.com/aelmanaa/hardhat-kms/issues/32)
