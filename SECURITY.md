# Security policy

`hardhat-kms` signs transactions and messages with keys that control funds. Please report
vulnerabilities privately, never in a public issue.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository ("Security" tab →
"Report a vulnerability"). Include the affected version, the provider (AWS, GCP, Azure),
reproduction steps and the impact you observed. You will get an acknowledgement within 3 business days.

## Scope

In scope: anything that could make the plugin sign something other than what was requested,
sign with a different key than configured, leak credentials or identifiers marked as sensitive,
broadcast a transaction twice, or bypass the chain-id checks.

Out of scope: the security of the cloud KMS services themselves and of the credentials on the
machine running Hardhat (see "Security model" in the README).
