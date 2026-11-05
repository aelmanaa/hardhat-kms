---
"@hardhat-kms/gcp": patch
---

The warning about `GOOGLE_SDK_NODE_LOGGING` now also appears when the variable is `true`. From google-logging-utils 2.1.0, which a new install resolves through google-gax 6.16, `true` turns on every log of Google's client libraries, including the access token of each token refresh; before, the plugin warned only for the values that turned them on in 2.0.

Issue: [#680](https://github.com/aelmanaa/hardhat-kms/issues/680)
