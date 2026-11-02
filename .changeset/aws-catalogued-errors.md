---
"@hardhat-kms/aws": patch
---

AWS KMS keys now explain the common credential and key failures. A missing credential, an expired IAM Identity Center (SSO) session, an `aws login` session without a usable token, a role profile that needs an MFA code and an expired session token each get a message that says what to run. `NotFoundException`, `AccessDeniedException`, `DisabledException`, `KMSInvalidStateException` and `KeyUnavailableException` get one too. The `NotFoundException` and `AccessDeniedException` messages name the region the AWS SDK sent the call to. Before, each of these showed only `the provider call failed (<class name>)`. The SDK's own messages are still never shown.

Issue: [#640](https://github.com/aelmanaa/hardhat-kms/issues/640)
