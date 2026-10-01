---
"hardhat-kms": minor
---

Add `kms accounts`, which lists the KMS keys with their provider, source, key id and address, and checks each key against the KMS and its `address` pin. Every key is tried: a key that fails is shown with its error, and the command then exits with code 1. A pin that does not match prints both addresses, and a key without a pin gets an `address` line to paste into its config. With `--network`, the task lists that network's keys; without it, every key, with each KMS key listed once. Key ids read from configuration variables are masked unless `--show-ids` is given, and `--json` prints the list as JSON. The JSON carries `"version": 1`, and its types, `AccountsReport` and `AccountEntry`, are exported from `hardhat-kms/types`.
