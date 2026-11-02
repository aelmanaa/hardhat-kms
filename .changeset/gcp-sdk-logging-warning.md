---
"@hardhat-kms/gcp": patch
---

The plugin now prints a warning on standard error, once per process, when `GOOGLE_SDK_NODE_LOGGING` turns on the logs of Google's client libraries. With the variable set to `kms`, `auth`, `*` or `all`, those libraries print every Cloud KMS request and response with the full key version name. google-auth-library also prints the access token of each token refresh and the log entries `kms history` reads. The warning appears when a Google Cloud key is first used or `kms history` reads one. The plugin does not change the variable. The warning's id is `gcp.debug.sdk-logging`.

What should I do? Unset `GOOGLE_SDK_NODE_LOGGING` outside a local debugging session, and never set it in CI. Use `DEBUG=hardhat:kms:*` to see what the plugin does.

Issue: [#635](https://github.com/aelmanaa/hardhat-kms/issues/635)
