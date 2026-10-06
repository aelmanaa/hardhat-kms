---
"@hardhat-kms/aws": minor
---

`kms history` now reads AWS keys. It lists the key's `Sign` events from CloudTrail event history in the key's Region, and finds calls made with an alias or a bare key id too. Reading needs `cloudtrail:LookupEvents`. An alias or a bare key id is first resolved with one `GetPublicKey` call, which CloudTrail logs. The read pages 50 events at a time, at most two requests a second, and stops after 60 pages or 90 seconds. The history is marked complete only when the credentials are in the key's account, the read is in the key's Region, the key is not multi-Region and every event could be tied to the key. Otherwise a note says what may be missing. A call from another account or an IAM Identity Center user has no principal ARN, so its caller is kept in the event's id fields. The package now depends on `@aws-sdk/client-cloudtrail` and `@aws-sdk/client-sts` 3.1143.0 or later, which load only when `kms history` reads an AWS key.

Issue: [#126](https://github.com/aelmanaa/hardhat-kms/issues/126)
