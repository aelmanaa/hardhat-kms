---
"@hardhat-kms/azure": patch
---

Send the `kms history` query to `api.loganalytics.azure.com`, which Microsoft is moving Log Analytics queries to, instead of `api.loganalytics.io`. If a firewall or proxy allowlist names `api.loganalytics.io`, add `api.loganalytics.azure.com`. The token is still requested for `https://api.loganalytics.io/.default`, so role assignments do not change.
