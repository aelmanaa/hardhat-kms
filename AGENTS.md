# AGENTS.md

This file tells coding agents where things are in hardhat-kms. Humans can start at [docs/README.md](docs/README.md).

hardhat-kms is a Hardhat 3 plugin that signs transactions, messages and typed data with secp256k1 keys in AWS KMS, Google Cloud KMS and Azure Key Vault. It works at the JSON-RPC layer, so viem, ethers and Ignition see KMS keys as ordinary accounts. The private key never leaves the KMS.

Status: not on npm yet. Unless a page marks something as planned, everything the docs describe has merged to `main`, and the plugin is still in development until the 1.0 release.

## If you are helping someone use the plugin

- A first deploy, start to finish (create an AWS KMS key, deploy and verify a contract on Sepolia, clean up): [docs/user/tutorials/first-deploy-aws.md](docs/user/tutorials/first-deploy-aws.md)
- The same first deploy with Google Cloud KMS (create an HSM key, deploy and verify a contract on Sepolia, schedule the key version for destruction): [docs/user/tutorials/first-deploy-gcp.md](docs/user/tutorials/first-deploy-gcp.md)
- The same first deploy with Azure Key Vault (create a vault and an `EC` key on `P-256K`, deploy and verify a contract on Sepolia, delete and purge the key): [docs/user/tutorials/first-deploy-azure.md](docs/user/tutorials/first-deploy-azure.md)
- Configure keys and networks: [docs/user/reference/configuration.md](docs/user/reference/configuration.md)
- Which JSON-RPC methods are handled, and which transaction types: [docs/user/reference/rpc-methods.md](docs/user/reference/rpc-methods.md)
- The `kms` tasks (list accounts, sign, verify, read a key's sign events from the provider's audit log): [docs/user/reference/tasks.md](docs/user/reference/tasks.md)
- What an error message means and how to fix it, by message text or id: [docs/user/reference/errors.md](docs/user/reference/errors.md)
- A viem account for a KMS key in library code (`connection.kms.getAccount`, for viem's `signAuthorization`, smart-account owners and scripts), what it refuses, and why its sends bypass the send lock: [docs/user/reference/library-accounts.md](docs/user/reference/library-accounts.md)
- The TypeScript API of `hardhat-kms`, `hardhat-kms/types` and `hardhat-kms/provider-utils`, generated from TSDoc: [docs/user/reference/api/README.md](docs/user/reference/api/README.md)
- Install the packages before the first npm release (build from the private repository, pack, install the tarballs; deleted at the release): [docs/user/guides/install-before-release.md](docs/user/guides/install-before-release.md)
- Set up an AWS KMS key (key spec, IAM policy, the `@hardhat-kms/aws` package, config): [docs/user/guides/aws-kms-setup.md](docs/user/guides/aws-kms-setup.md)
- Set up an Azure Key Vault key (key type and curve, RBAC role or access policy, credential order, the `@hardhat-kms/azure` package): [docs/user/guides/azure-key-vault-setup.md](docs/user/guides/azure-key-vault-setup.md)
- Set up a Google Cloud KMS key (algorithm, HSM protection level, IAM roles, the `@hardhat-kms/gcp` package, config, errors): [docs/user/guides/gcp-kms-setup.md](docs/user/guides/gcp-kms-setup.md)
- A key was deleted or nobody can reach it, or a key is being retired (each provider's waiting period and undo, guardrails, lockout, backups): [docs/user/guides/key-loss.md](docs/user/guides/key-loss.md)
- Rotate a key, or catch an alias or Azure key version that changed under the config (what rotation does per provider, `address` pins, moving to a new key): [docs/user/guides/key-rotation.md](docs/user/guides/key-rotation.md)
- Use several keys across networks and providers, next to local or Ledger accounts, and pick the sender: [docs/user/guides/multiple-keys.md](docs/user/guides/multiple-keys.md)
- Turn on and read the debug output: [docs/user/guides/debug-output.md](docs/user/guides/debug-output.md)
- Deploy with Hardhat Ignition from a KMS account (choosing the deployer, rehearsing on a simulated network): [docs/user/guides/deploy-with-ignition.md](docs/user/guides/deploy-with-ignition.md)
- Complete projects to copy, which deploy and call a contract with viem, ethers or Ignition: [examples/README.md](examples/README.md)
- Coming from Foundry: [docs/user/guides/migrate-from-foundry.md](docs/user/guides/migrate-from-foundry.md) and [docs/user/explanation/foundry-comparison.md](docs/user/explanation/foundry-comparison.md)
- How a request goes from viem or ethers through the plugin to the KMS and the node: [docs/user/explanation/how-it-works.md](docs/user/explanation/how-it-works.md)
- Which credentials sign on a laptop, in CI and on a server, per cloud: [docs/user/explanation/cloud-access.md](docs/user/explanation/cloud-access.md)
- What the plugin protects against and what it does not, what to configure, and what happens when a KMS call times out: [docs/user/explanation/security-model.md](docs/user/explanation/security-model.md)
- Pages not written yet (the remaining guides, a docs site): [docs/contributor/documentation.md#planned-pages](docs/contributor/documentation.md#planned-pages)

Never ask a user to paste credentials, private keys or API-keyed RPC URLs. Credentials come from each provider SDK's default chain, never from the Hardhat config. API-keyed RPC URLs belong in `configVariable()`, which also accepts key identifiers.

## If you are changing the code

Start with [CONTRIBUTING.md](CONTRIBUTING.md), then [docs/contributor/architecture.md](docs/contributor/architecture.md).

Commands (Node.js 24, see `.nvmrc`):

```sh
pnpm install                    # installs dependencies and git hooks
pnpm run check                  # format, type-aware lint, typecheck, no type escapes
pnpm run test:unit              # fast unit tests
pnpm test                       # unit and integration tests
pnpm run test:localstack        # AWS adapter against LocalStack (needs Docker)
pnpm run test:examples          # the projects in examples/ against LocalStack (needs Docker)
pnpm run test:sdk-floors        # provider packages against their lowest SDK versions
pnpm run test:hardhat-versions  # fill tests on the Hardhat floor and latest 3.x
pnpm run test:mutation          # Stryker on the core's crypto/ and signer/ (incremental)
pnpm run test:live              # deploys, sends and signs with each configured key on a Sepolia fork (needs anvil); HARDHAT_KMS_LIVE_NETWORK=sepolia runs it on real Sepolia
pnpm run test:live:aws          # AWS adapter against real KMS (needs HARDHAT_KMS_LIVE_AWS_KEY_ID)
pnpm run coverage               # tests with the 95% coverage threshold
pnpm run pkg:check              # build, publint, arethetypeswrong, knip
pnpm run docs:check             # doc snippets typecheck, every page is indexed, generated pages are current, Mermaid blocks parse
pnpm run docs:errors            # regenerate docs/user/reference/errors.md from the error catalogues
pnpm run docs:api               # build, then regenerate docs/user/reference/api/ from TSDoc
```

Where things are:

- `packages/hardhat-kms`: the core plugin. Its public entry points are `hardhat-kms`, `hardhat-kms/types` (config and provider types) and `hardhat-kms/provider-utils` (helpers for provider plugins, `@experimental`).
- `packages/hardhat-kms-aws`: the AWS KMS provider plugin, which depends on `@aws-sdk/client-kms`.
- `packages/hardhat-kms-azure`: the Azure Key Vault provider plugin, which depends on `@azure/keyvault-keys` and `@azure/identity`.
- `packages/hardhat-kms-gcp`: the Google Cloud KMS provider plugin, which depends on `@google-cloud/kms`.
- `tools/api-docs`: a private package, never published, that runs TypeDoc on TypeScript 6 for the API reference ([decision 0012](docs/contributor/decisions/0012-api-reference-generator.md)).
- `examples/`: Hardhat projects that deploy and call a contract from a KMS account with viem, ethers and Ignition. They are workspace members, and `pnpm run test:examples` runs them against LocalStack.

| Topic                                                | Page                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Module map, code map, request flows                  | [docs/contributor/architecture.md](docs/contributor/architecture.md)                             |
| Signature checks, key pinning, threat model          | [docs/contributor/signing-pipeline.md](docs/contributor/signing-pipeline.md)                     |
| Adapter interface, provider packages                 | [docs/contributor/providers.md](docs/contributor/providers.md)                                   |
| Transaction filling, nonces, send lock               | [docs/contributor/transactions.md](docs/contributor/transactions.md)                             |
| Test layers and conventions                          | [docs/contributor/testing.md](docs/contributor/testing.md)                                       |
| Transactions of the latest live run on Sepolia       | [docs/live-proof.md](docs/live-proof.md)                                                         |
| Quality gates, hooks, CI                             | [docs/contributor/tooling.md](docs/contributor/tooling.md)                                       |
| Who releases, the signed tag, staging and promotion  | [docs/contributor/releasing.md](docs/contributor/releasing.md)                                   |
| How the docs are organised                           | [docs/contributor/documentation.md](docs/contributor/documentation.md)                           |
| Why the main decisions were made                     | [docs/contributor/decisions/README.md](docs/contributor/decisions/README.md)                     |
| How other signers compare, and why each check exists | [docs/contributor/research/signing-prior-art.md](docs/contributor/research/signing-prior-art.md) |
| Roadmap                                              | [docs/contributor/roadmap.md](docs/contributor/roadmap.md)                                       |

Decision records:

- [0001: Vendor the EIP-712 encoder from micro-eth-signer 0.19](docs/contributor/decisions/0001-vendor-eip712-encoder.md)
- [0002: Fill transactions in the plugin](docs/contributor/decisions/0002-fill-transactions-in-plugin.md)
- [0003: No RPC method signs a bare digest](docs/contributor/decisions/0003-no-bare-digest-over-rpc.md)
- [0004: Recover the parity against the known key and verify every signature](docs/contributor/decisions/0004-verify-every-signature.md)
- [0005: Load cloud SDKs lazily from the user's project](docs/contributor/decisions/0005-lazy-sdk-loading.md) (superseded by 0009)
- [0006: A plugin-owned `kms` hook for third-party providers](docs/contributor/decisions/0006-kms-hook-for-providers.md)
- [0007: oxlint, oxfmt and TypeScript 7](docs/contributor/decisions/0007-toolchain.md)
- [0008: Choose KMS keys from the command line with `--kms`](docs/contributor/decisions/0008-kms-command-line-option.md)
- [0009: Ship each cloud provider as its own package](docs/contributor/decisions/0009-one-package-per-provider.md) (amended by 0015)
- [0010: Use pnpm workspaces](docs/contributor/decisions/0010-pnpm-workspaces.md)
- [0011: Check typed data's chain only when it names one](docs/contributor/decisions/0011-typed-data-chain-check.md)
- [0012: Generate the API reference with TypeDoc on TypeScript 6](docs/contributor/decisions/0012-api-reference-generator.md)
- [0013: Signing history comes only from the cloud audit logs](docs/contributor/decisions/0013-history-from-cloud-logs.md)
- [0014: The library account signs bare digests only when asked](docs/contributor/decisions/0014-library-account-raw-sign.md)
- [0015: npm names: an unscoped core and scoped providers](docs/contributor/decisions/0015-npm-names.md)
- [0016: Release from a signed tag, stage to `beta`, promote by dist-tag](docs/contributor/decisions/0016-release-process.md)
- [0017: The docs site lives at aelmanaa.github.io/hardhat-kms](docs/contributor/decisions/0017-docs-hostname.md)

Rules for every change:

- Work from a GitHub issue, and link it from the pull request (`Closes #n`). Labels, priorities and milestones are described in [CONTRIBUTING.md](CONTRIBUTING.md#issues-first).
- `main` changes only through squash-merged pull requests. Commit subjects follow Conventional Commits.
- Every user-facing change carries a changeset written as a release note. The rules and an example are in [CONTRIBUTING.md](CONTRIBUTING.md#changesets).
- Never tag, publish, approve a GitHub environment, approve a staged package on npm, or move a dist-tag. A release is a maintainer's action; the process is in [docs/contributor/releasing.md](docs/contributor/releasing.md).
- Versions change only through `pnpm run version-packages`, on the Version Packages pull request. Never edit a manifest's `version` by hand.
- Tests come with the change, and coverage stays at or above 95%.
- Docs ship with the code: update the pages the change affects, and link any new page from this file and from [docs/README.md](docs/README.md).
- Do not edit `packages/hardhat-kms/src/internal/vendor/`. It is micro-eth-signer 0.19.0 code with only import paths changed; see [decision 0001](docs/contributor/decisions/0001-vendor-eip712-encoder.md).
- Before changing code that decides what gets signed (`packages/hardhat-kms/src/internal/crypto/`, `packages/hardhat-kms/src/internal/signer/`), read [docs/contributor/signing-pipeline.md](docs/contributor/signing-pipeline.md).
- Never print or commit secrets, key ids from real accounts, or API-keyed RPC URLs, including in tests, logs and error messages.
- After changing a TSDoc comment or a public type of `hardhat-kms`, run `pnpm run docs:api`.
- Build every error from a catalogue entry (`src/internal/error-catalog.ts`) with `catalogError`, `catalogMessage` or `internalError`, then run `pnpm run docs:errors`. See [Errors](docs/contributor/architecture.md#errors).
- Do not silence the type checker or the linter in shipped code: no `any`, no `@ts-` directives, no casts to get past a type. Use a type guard, an assertion function with real checks, narrowing on a discriminant, or a parse function that returns the checked type. `pnpm run check` runs `scripts/check-type-escapes.ts`, which fails on any escape, type predicate or assertion function not listed with its count and reason in `scripts/type-escapes.json`.
