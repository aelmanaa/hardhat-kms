---
"@hardhat-kms/gcp": patch
---

`@hardhat-kms/gcp` depends on `google-gax` `^6.5.0 <6.11.0 || ^6.11.1`: 6.5.0 or later in major 6, except 6.11.0, which npm marks as deprecated "due to a known bug". The plugin sends its Cloud KMS requests through that copy, so they never run on 6.11.0. Yarn 1, pnpm 10, or a later pnpm with registry data cached before the deprecation, can still install 6.11.0 under `@google-cloud/kms` for that library's logging and error decoding; the [Google Cloud KMS setup guide](https://aelmanaa.github.io/hardhat-kms/user/guides/gcp-kms-setup#keep-google-gax-off-6110) shows the override that removes it for npm, pnpm and Yarn.

Issue: [#384](https://github.com/aelmanaa/hardhat-kms/issues/384)
