---
"@hardhat-kms/gcp": patch
---

With workload identity federation and `GOOGLE_CLOUD_PROJECT` unset, signing now works when the identity has only the two roles on the key, and `kms history` when it also has the Logging role the setup guide grants. Before, Google's client library looked the project up through Cloud Resource Manager, which such an identity may not call. Signing then failed with `the provider call failed (Error)` before any request reached Cloud KMS, and `kms history` wrongly reported a missing Cloud Logging permission. The plugin now passes the project from `keyVersionName`, so no lookup is made.

A refused token exchange now reports its OAuth error code, for example `the token exchange refused the external credentials (invalid_grant)`, in the new `gcp.connect.token-exchange` error. Another refused request on the way to an access token reports the endpoint and its HTTP status in the new `gcp.connect.auth-endpoint` error. Neither shows the request path, the project number or the server's description. Both are for a refusal (a 4xx status other than 408 and 429); a server error, a timeout or throttling on the way to a token is retried as before.

An expired or revoked `gcloud auth application-default login` that the OAuth token endpoint refuses with HTTP 400 now reports `the Google Cloud credentials were refused (UNAUTHENTICATED)` with its next step, as a 401 already did, instead of `the Google Cloud KMS call failed (INVALID_ARGUMENT)`.

What should I do? Nothing. If you set `GOOGLE_CLOUD_PROJECT` only to get around this, you can remove it.

Issue: [#394](https://github.com/aelmanaa/hardhat-kms/issues/394)
