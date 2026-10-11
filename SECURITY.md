# Security policy

`hardhat-kms` signs transactions and messages with keys that control funds. Please report
vulnerabilities privately, never in a public issue.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository: open the "Security" tab and
choose "Report a vulnerability". Include the affected version, the provider (AWS, GCP, Azure),
reproduction steps and the impact you observed. You will get an acknowledgement within 3 business days.

## Scope

In scope: anything that could make the plugin sign something other than what was requested,
sign with a different key than configured, leak credentials or identifiers marked as sensitive,
broadcast a transaction twice, or bypass the chain-id checks.

Out of scope: the security of the cloud KMS services themselves and of the credentials on the
machine running Hardhat (see the [security model](docs/user/explanation/security-model.md) and the [threat model](docs/contributor/signing-pipeline.md#threat-model-summary)).

## Review before 1.0

The maintainer recorded a [review of the signing and sending paths](https://github.com/aelmanaa/hardhat-kms/issues/334#issuecomment-6066667282)
at `v0.10.0` (`953a9e3`), assisted by two AI review agents (Claude Code). The review covered key
identity, signed bytes, timeouts, broadcasting, retries, library-account nonces and connection
lifecycle. The summary lists each finding and its disposition. The maintainer owns those decisions.

The required fixes in [#433](https://github.com/aelmanaa/hardhat-kms/issues/433),
[#434](https://github.com/aelmanaa/hardhat-kms/issues/434),
[#435](https://github.com/aelmanaa/hardhat-kms/issues/435) and
[#436](https://github.com/aelmanaa/hardhat-kms/issues/436) shipped in 0.10.1. The published 0.10.1
packages passed the [registry acceptance checks](https://github.com/aelmanaa/hardhat-kms/issues/466)
on AWS, Google Cloud and Azure. Those results apply to the reviewed versions; each new release
follows the checks in [Releasing](docs/contributor/releasing.md).
