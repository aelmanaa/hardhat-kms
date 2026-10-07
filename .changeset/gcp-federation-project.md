---
"@hardhat-kms/gcp": patch
---

Signing and `kms history` now work with workload identity federation when the identity has only the two roles on the key and `GOOGLE_CLOUD_PROJECT` is not set. Before, Google's client library looked the project up through Cloud Resource Manager, which such an identity may not call. Signing then failed with `the provider call failed (Error)` before any request reached Cloud KMS, and `kms history` wrongly reported a missing Cloud Logging permission. The plugin now passes the project from `keyVersionName`, so no lookup is made.

A refused token exchange now reports its OAuth error code, for example `the token exchange refused the external credentials (invalid_grant)`, in the new `gcp.connect.token-exchange` error. Another refused request on the way to an access token reports the endpoint and its HTTP status in the new `gcp.connect.auth-endpoint` error. Neither shows the request path, the project number or the server's description.

What should I do? Nothing. If you set `GOOGLE_CLOUD_PROJECT` only to get around this, you can remove it.

Issue: [#394](https://github.com/aelmanaa/hardhat-kms/issues/394)
