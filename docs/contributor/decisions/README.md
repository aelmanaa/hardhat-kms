# Decision records

Each record explains one decision a contributor might otherwise question: the context, the decision, and what follows from it. Once a record is accepted, its decision does not change; later evidence and references go in an Evidence section. A later decision that changes one supersedes it, and both link to each other.

To add a record, copy [template.md](template.md) to the next number and open a pull request with its issue.

| #                                           | Decision                                                            | Status   |
| ------------------------------------------- | ------------------------------------------------------------------- | -------- |
| [0001](0001-vendor-eip712-encoder.md)       | Vendor the EIP-712 encoder from micro-eth-signer 0.19               | Accepted |
| [0002](0002-fill-transactions-in-plugin.md) | Fill transactions in the plugin                                     | Accepted |
| [0003](0003-no-bare-digest-over-rpc.md)     | No RPC method signs a bare digest                                   | Accepted |
| [0004](0004-verify-every-signature.md)      | Recover the parity against the known key and verify every signature | Accepted |
| [0005](0005-lazy-sdk-loading.md)            | Load cloud SDKs lazily from the user's project                      | Accepted |
| [0006](0006-kms-hook-for-providers.md)      | A plugin-owned `kms` hook for third-party providers                 | Accepted |
| [0007](0007-toolchain.md)                   | oxlint, oxfmt and TypeScript 7                                      | Accepted |
