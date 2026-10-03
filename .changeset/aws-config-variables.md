---
"hardhat-kms": minor
"@hardhat-kms/aws": minor
---

An AWS key's `profile` and `region`, and `kms.defaults.aws.region`, now take `configVariable(...)` as well as a literal string, so one config works on a laptop and in CI. A value from a variable is read and trimmed when the key is first used; an empty value means the field is unset, so `configVariable("AWS_KMS_PROFILE", { default: "" })` makes the profile optional. An unset variable without a `default` fails at first use with Hardhat's error, which names the variable. The region order stays the same, and an empty `region` falls through to `kms.defaults.aws.region`. A key ARN whose region conflicts with a `region` from a variable fails when the key is first used, and the message names the variable, not its value. Errors and `kms accounts` show a value from a variable as `<VARIABLE_NAME>`, and `kms history` masks the value as `<hidden>`; `--show-ids` prints it in both tasks. `--kms aws` keys use a `kms.defaults.aws.region` from a variable too.

Breaking change to the resolved types: `AwsKmsKeyConfig.region`, `AwsKmsKeyConfig.profile` and `KmsConfig.defaults.aws.region` are now `KmsIdentifier` values instead of strings. Read one with `await key.region?.get()`, which returns an empty string for an empty value, and print `key.region?.display`. A third-party plugin that reads these fields must update. The `kms accounts` report keeps `region` and `profile` as strings, showing `<NAME>` for a value from a variable unless `--show-ids` is given.

`kms history` builds its CloudTrail, STS and KMS clients with the profile and region read from the variables. Two keys whose settings differ only in a variable's name, `format` or `default` get separate signers; two config entries whose values name the same KMS key are still listed as one account.
