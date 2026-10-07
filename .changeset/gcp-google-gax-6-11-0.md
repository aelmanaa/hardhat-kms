---
"@hardhat-kms/gcp": patch
---

`@hardhat-kms/gcp` no longer installs `google-gax` 6.11.0, which npm marks as deprecated "due to a known bug". It now depends on `google-gax` `^6.5.0 <6.11.0 || ^6.11.1`: 6.5.0 or later in major 6, except 6.11.0, so its Cloud KMS requests never run on 6.11.0. Yarn 1 can still install 6.11.0 under `@google-cloud/kms` for that library's logging and error decoding; the [Google Cloud KMS setup guide](https://aelmanaa.github.io/hardhat-kms/user/guides/gcp-kms-setup#3-install-the-plugin-and-configure-the-key) shows the override that removes it for npm, pnpm and Yarn.

Issue: [#384](https://github.com/aelmanaa/hardhat-kms/issues/384)
