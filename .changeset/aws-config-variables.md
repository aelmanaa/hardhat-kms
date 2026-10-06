---
"hardhat-kms": minor
"@hardhat-kms/aws": minor
---

An AWS key's `profile` and `region`, and `kms.defaults.aws.region`, now take `configVariable(...)` as well as a literal string, so one config works on a laptop and in CI. The plugin reads and trims the variable when the key is first used. An empty value leaves the field unset, so `configVariable("AWS_KMS_PROFILE", { default: "" })` makes the profile optional. An unset variable without a `default` fails at first use with Hardhat's error, which names the variable. An empty `region` falls through to `kms.defaults.aws.region`. A key ARN whose region conflicts with a `region` from a variable fails at first use, and the message names the variable, not its value. Errors and `kms accounts` show a value from a variable as `<VARIABLE_NAME>`. `kms history` masks it as `<hidden>`. `--show-ids` prints the value in both tasks. `--kms aws` keys use a `kms.defaults.aws.region` from a variable too.

What should I do? Nothing changes in a config that uses literal strings. In the resolved config, `AwsKmsKeyConfig.region`, `AwsKmsKeyConfig.profile` and `KmsConfig.defaults.aws.region` are now `KmsIdentifier` values. A plugin that reads one of them should call `await key.region?.get()`, which returns an empty string for an empty value, and print `key.region?.display`. The `kms accounts` report keeps `region` and `profile` as strings.

Issue: [#243](https://github.com/aelmanaa/hardhat-kms/issues/243)
