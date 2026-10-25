---
"hardhat-kms": patch
---

`kms sign-auth` and `kms sign-tx` now refuse a `--kms` AWS key with the same key id or alias as a config key with `allowedDelegates`, even when the two keys set the region, profile or endpoint differently, or one of them writes the key as an ARN. Before, a config key that set its own `region` while the `--kms` key took its region from `AWS_REGION` was not refused, so the config key's list did not apply. An Azure key URL now matches whatever its case or trailing slash, and a key URL without a version matches every version of that key.

Issue: [#589](https://github.com/aelmanaa/hardhat-kms/issues/589)
