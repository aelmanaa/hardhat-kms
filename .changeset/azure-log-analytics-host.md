---
"@hardhat-kms/azure": patch
---

`kms history` now sends its Log Analytics query to `api.loganalytics.azure.com`, the host Microsoft is moving Log Analytics queries to. Before, it sent the query to `api.loganalytics.io`. The token is still requested for `https://api.loganalytics.io/.default`, so role assignments do not change.

What should I do? If a firewall or proxy allowlist names `api.loganalytics.io`, add `api.loganalytics.azure.com`.

Issue: [#252](https://github.com/aelmanaa/hardhat-kms/issues/252)
