# Decision records

Each record explains one decision a contributor might otherwise question: the context, the decision, and what follows from it. Once a record is accepted, its decision does not change; later evidence and references go in an Evidence section. A later decision that changes one supersedes it, or amends it when most of it still holds, and both link to each other.

To add a record, copy [template.md](template.md) to the next number and open a pull request with its issue.

| #                                                      | Decision                                                                         | Status                    |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------- |
| [0001](0001-vendor-eip712-encoder.md)                  | Vendor the EIP-712 encoder from micro-eth-signer 0.19                            | Accepted                  |
| [0002](0002-fill-transactions-in-plugin.md)            | Fill transactions in the plugin                                                  | Accepted                  |
| [0003](0003-no-bare-digest-over-rpc.md)                | No RPC method signs a bare digest                                                | Amended by 0021           |
| [0004](0004-verify-every-signature.md)                 | Recover the parity against the known key and verify every signature              | Accepted                  |
| [0005](0005-lazy-sdk-loading.md)                       | Load cloud SDKs lazily from the user's project                                   | Superseded by 0009        |
| [0006](0006-kms-hook-for-providers.md)                 | A plugin-owned `kms` hook for third-party providers                              | Accepted                  |
| [0007](0007-toolchain.md)                              | oxlint, oxfmt and TypeScript 7                                                   | Accepted                  |
| [0008](0008-kms-command-line-option.md)                | Choose KMS keys from the command line with `--kms`                               | Accepted                  |
| [0009](0009-one-package-per-provider.md)               | Ship each cloud provider as its own package                                      | Amended by 0015, 0019     |
| [0010](0010-pnpm-workspaces.md)                        | Use pnpm workspaces                                                              | Accepted                  |
| [0011](0011-typed-data-chain-check.md)                 | Check typed data's chain only when it names one                                  | Accepted                  |
| [0012](0012-api-reference-generator.md)                | Generate the API reference with TypeDoc on TypeScript 6                          | Accepted                  |
| [0013](0013-history-from-cloud-logs.md)                | Signing history comes only from the cloud audit logs                             | Accepted                  |
| [0014](0014-library-account-raw-sign.md)               | The library account signs bare digests only when asked                           | Amended by 0021           |
| [0015](0015-npm-names.md)                              | npm names: an unscoped core and scoped providers                                 | Accepted                  |
| [0016](0016-release-process.md)                        | Release from a signed tag, stage to `beta`, promote by dist-tag                  | Accepted                  |
| [0017](0017-docs-hostname.md)                          | The docs site lives at aelmanaa.github.io/hardhat-kms                            | Accepted                  |
| [0018](0018-refuse-requested-type-mismatch.md)         | Refuse a requested type that disagrees with the caller's fee fields              | Accepted                  |
| [0019](0019-turnkey-without-sdk.md)                    | Call Turnkey's API without a Turnkey SDK                                         | Accepted                  |
| [0020](0020-turnkey-approvals-fail-fast.md)            | Fail at once when a Turnkey activity needs approval                              | Accepted, amended by #537 |
| [0021](0021-raw-digests-need-a-person-or-an-opt-in.md) | Raw digests need a person at a terminal or a per-key opt-in                      | Accepted                  |
| [0022](0022-per-key-delegate-allowlist.md)             | Each key can limit its EIP-7702 delegates, per chain                             | Accepted                  |
| [0023](0023-confirm-authorizations-at-a-terminal.md)   | Confirm EIP-7702 authorizations at a terminal, and refuse ones that cannot apply | Accepted                  |
| [0024](0024-docs-site-follows-npm-latest.md)           | The docs site root follows npm `latest`, and main's docs are under `next/`       | Accepted                  |
