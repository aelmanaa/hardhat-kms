# AGENTS.md

This file tells coding agents where things are in hardhat-kms. Humans can start at [docs/README.md](docs/README.md).

hardhat-kms is a Hardhat 3 plugin that signs transactions, messages and typed data with secp256k1 keys in AWS KMS, Google Cloud KMS and Azure Key Vault. It works at the JSON-RPC layer, so viem, ethers and Ignition see KMS keys as ordinary accounts. The private key never leaves the KMS.

Status: in development, not on npm. Most user-facing behaviour is still planned, and each page's Status line says which milestone delivers it.

## If you are helping someone use the plugin

- Configure keys and networks: [docs/user/reference/configuration.md](docs/user/reference/configuration.md)
- Which JSON-RPC methods are handled, and which transaction types: [docs/user/reference/rpc-methods.md](docs/user/reference/rpc-methods.md)
- The `kms` tasks (list accounts, sign, verify): [docs/user/reference/tasks.md](docs/user/reference/tasks.md)
- Set up an AWS KMS key (key spec, IAM policy, config): [docs/user/guides/aws-kms-setup.md](docs/user/guides/aws-kms-setup.md)
- Turn on and read the debug output: [docs/user/guides/debug-output.md](docs/user/guides/debug-output.md)
- Coming from Foundry: [docs/user/guides/migrate-from-foundry.md](docs/user/guides/migrate-from-foundry.md) and [docs/user/explanation/foundry-comparison.md](docs/user/explanation/foundry-comparison.md)
- What the plugin protects against and what it does not: [docs/contributor/signing-pipeline.md#threat-model-summary](docs/contributor/signing-pipeline.md#threat-model-summary)
- Pages not written yet (tutorials, key setup guides, errors): [docs/contributor/documentation.md#planned-pages](docs/contributor/documentation.md#planned-pages)

Never ask a user to paste credentials, private keys or API-keyed RPC URLs. Credentials come from each provider SDK's default chain, never from the Hardhat config. API-keyed RPC URLs belong in `configVariable()`, which also accepts key identifiers.

## If you are changing the code

Start with [CONTRIBUTING.md](CONTRIBUTING.md), then [docs/contributor/architecture.md](docs/contributor/architecture.md).

Commands (Node.js 24, see `.nvmrc`):

```sh
npm install          # installs dependencies and git hooks
npm run check        # format check, type-aware lint, typecheck
npm run test:unit    # fast unit tests
npm test             # unit and integration tests
npm run coverage     # tests with the 95% coverage threshold
npm run pkg:check    # build, publint, arethetypeswrong, knip
npm run docs:check   # doc snippets typecheck, every page is indexed
```

Where things are:

| Topic                                                | Page                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Module map, code map, request flows                  | [docs/contributor/architecture.md](docs/contributor/architecture.md)                             |
| Signature checks, key pinning, threat model          | [docs/contributor/signing-pipeline.md](docs/contributor/signing-pipeline.md)                     |
| Adapter interface for providers                      | [docs/contributor/providers.md](docs/contributor/providers.md)                                   |
| Transaction filling, nonces, send lock               | [docs/contributor/transactions.md](docs/contributor/transactions.md)                             |
| Test layers and conventions                          | [docs/contributor/testing.md](docs/contributor/testing.md)                                       |
| Quality gates, hooks, CI                             | [docs/contributor/tooling.md](docs/contributor/tooling.md)                                       |
| How the docs are organised                           | [docs/contributor/documentation.md](docs/contributor/documentation.md)                           |
| Why the main decisions were made                     | [docs/contributor/decisions/README.md](docs/contributor/decisions/README.md)                     |
| How other signers compare, and why each check exists | [docs/contributor/research/signing-prior-art.md](docs/contributor/research/signing-prior-art.md) |
| Roadmap and milestones                               | [docs/contributor/roadmap.md](docs/contributor/roadmap.md)                                       |
| Former design document (section redirects)           | [docs/DESIGN.md](docs/DESIGN.md)                                                                 |

Decision records:

- [0001: Vendor the EIP-712 encoder from micro-eth-signer 0.19](docs/contributor/decisions/0001-vendor-eip712-encoder.md)
- [0002: Fill transactions in the plugin](docs/contributor/decisions/0002-fill-transactions-in-plugin.md)
- [0003: No RPC method signs a bare digest](docs/contributor/decisions/0003-no-bare-digest-over-rpc.md)
- [0004: Recover the parity against the known key and verify every signature](docs/contributor/decisions/0004-verify-every-signature.md)
- [0005: Load cloud SDKs lazily from the user's project](docs/contributor/decisions/0005-lazy-sdk-loading.md)
- [0006: A plugin-owned `kms` hook for third-party providers](docs/contributor/decisions/0006-kms-hook-for-providers.md)
- [0007: oxlint, oxfmt and TypeScript 7](docs/contributor/decisions/0007-toolchain.md)
- [0008: Choose KMS keys from the command line with `--kms`](docs/contributor/decisions/0008-kms-command-line-option.md)
- [0009: Ship each cloud provider as its own package](docs/contributor/decisions/0009-one-package-per-provider.md)
- [0010: Use pnpm workspaces](docs/contributor/decisions/0010-pnpm-workspaces.md)

Rules for every change:

- Work from a GitHub issue, and link it from the pull request (`Closes #n`). Labels, priorities and milestones are described in [CONTRIBUTING.md](CONTRIBUTING.md#issues-first).
- `main` changes only through squash-merged pull requests. Commit subjects follow Conventional Commits.
- Tests come with the change, and coverage stays at or above 95%.
- Docs ship with the code: update the pages the change affects, and link any new page from this file and from [docs/README.md](docs/README.md).
- Do not edit `src/internal/vendor/`. It is micro-eth-signer 0.19.0 code with only import paths changed; see [decision 0001](docs/contributor/decisions/0001-vendor-eip712-encoder.md).
- Before changing code that decides what gets signed (`src/internal/crypto/`, `src/internal/signer/`), read [docs/contributor/signing-pipeline.md](docs/contributor/signing-pipeline.md).
- Never print or commit secrets, key ids from real accounts, or API-keyed RPC URLs, including in tests, logs and error messages.
