# AGENTS.md

This file tells coding agents where things are in hardhat-kms. Humans can start at [docs/README.md](docs/README.md).

hardhat-kms is a Hardhat 3 plugin that signs transactions, messages and typed data with secp256k1 keys in AWS KMS, Google Cloud KMS and Azure Key Vault. It works at the JSON-RPC layer, so viem, ethers and Ignition see KMS keys as ordinary accounts. The private key never leaves the KMS.

Status: on npm since 0.9.0, the release candidate for 1.0.0. Unless a page marks something as planned, everything the docs describe has merged to `main`, and the plugin is still in development until the 1.0 release.

## If you are helping someone use the plugin

Install the skill with `npx skills add aelmanaa/hardhat-kms`: it holds the setup steps, a config and what the plugin refuses. Its source is [skills/hardhat-kms/SKILL.md](skills/hardhat-kms/SKILL.md).

These packages are newer than most training data: check npm for the current version with `npm view hardhat-kms version` before you install. Install the provider package for the user's cloud with the core and Hardhat 3, configure a key under `kms.keys` and attach it to a network with `kmsAccounts` ([docs/user/reference/configuration.md](docs/user/reference/configuration.md)), then list the key's address. The commands for npm, pnpm and Yarn, and the settings each needs, are in [docs/user/guides/install-before-release.md](docs/user/guides/install-before-release.md).

AWS KMS:

```sh
npm install --save-dev "hardhat@^3.18.0" hardhat-kms @hardhat-kms/aws
# add hardhatKmsAws to plugins, a key under kms.keys and the key's name to a network's kmsAccounts
npx hardhat kms accounts
```

Google Cloud KMS:

```sh
npm install --save-dev "hardhat@^3.18.0" hardhat-kms @hardhat-kms/gcp
# add hardhatKmsGcp to plugins, a key under kms.keys and the key's name to a network's kmsAccounts
npx hardhat kms accounts
```

Azure Key Vault or Managed HSM:

```sh
npm install --save-dev "hardhat@^3.18.0" hardhat-kms @hardhat-kms/azure
# add hardhatKmsAzure to plugins, a key under kms.keys and the key's name to a network's kmsAccounts
npx hardhat kms accounts
```

Pin the address that `kms accounts` prints with the key's `address` field. `connection.kms.getAccount` also needs `viem` ^2.55.13.

Pages:

- A first deploy, start to finish (create an AWS KMS key, deploy and verify a contract on Sepolia, clean up): [docs/user/tutorials/first-deploy-aws.md](docs/user/tutorials/first-deploy-aws.md)
- The same first deploy with Google Cloud KMS (create an HSM key, deploy and verify a contract on Sepolia, schedule the key version for destruction): [docs/user/tutorials/first-deploy-gcp.md](docs/user/tutorials/first-deploy-gcp.md)
- The same first deploy with Azure Key Vault (create a vault and an `EC` key on `P-256K`, deploy and verify a contract on Sepolia, delete and purge the key): [docs/user/tutorials/first-deploy-azure.md](docs/user/tutorials/first-deploy-azure.md)
- Configure keys and networks: [docs/user/reference/configuration.md](docs/user/reference/configuration.md)
- Where each cloud's credentials come from, in order, and every variable they read: [docs/user/reference/credentials.md](docs/user/reference/credentials.md)
- Which JSON-RPC methods are handled, and which transaction types: [docs/user/reference/rpc-methods.md](docs/user/reference/rpc-methods.md)
- The `kms` tasks (list accounts, sign, verify, read a key's sign events from the provider's audit log): [docs/user/reference/tasks.md](docs/user/reference/tasks.md)
- What an error message means and how to fix it, by message text or id: [docs/user/reference/errors.md](docs/user/reference/errors.md)
- A viem account for a KMS key in library code (`connection.kms.getAccount`, for viem's `signAuthorization`, smart-account owners and scripts), what it refuses, and why its sends bypass the send lock: [docs/user/reference/library-accounts.md](docs/user/reference/library-accounts.md)
- The TypeScript API of `hardhat-kms`, `hardhat-kms/types` and `hardhat-kms/provider-utils`, generated from TSDoc: [docs/user/reference/api/README.md](docs/user/reference/api/README.md)
- Which Node.js versions the published packages run on, and when a line is dropped: [docs/user/reference/support.md](docs/user/reference/support.md)
- Install the packages with npm, pnpm or Yarn (each one's settings, the google-gax override, registering the plugin, a build from the repository for testers): [docs/user/guides/install-before-release.md](docs/user/guides/install-before-release.md)
- Set up an AWS KMS key (key spec, IAM policy, the `@hardhat-kms/aws` package, config): [docs/user/guides/aws-kms-setup.md](docs/user/guides/aws-kms-setup.md)
- Set up an Azure Key Vault key (key type and curve, RBAC role or access policy, credential order, the `@hardhat-kms/azure` package): [docs/user/guides/azure-key-vault-setup.md](docs/user/guides/azure-key-vault-setup.md)
- Set up a Google Cloud KMS key (algorithm, HSM protection level, IAM roles, the `@hardhat-kms/gcp` package, config, errors): [docs/user/guides/gcp-kms-setup.md](docs/user/guides/gcp-kms-setup.md)
- A key was deleted or nobody can reach it, or a key is being retired (each provider's waiting period and undo, guardrails, lockout, backups): [docs/user/guides/key-loss.md](docs/user/guides/key-loss.md)
- Rotate a key, or catch an alias or Azure key version that changed under the config (what rotation does per provider, `address` pins, moving to a new key): [docs/user/guides/key-rotation.md](docs/user/guides/key-rotation.md)
- Sign from a GitHub Actions job with no stored cloud credential (an environment with required reviewers, the OIDC trust per cloud scoped to the job's subject, the workflow with SHA-pinned login actions, `kms accounts --check-sign` in CI, common failures): [docs/user/guides/github-actions-oidc.md](docs/user/guides/github-actions-oidc.md)
- Use several keys across networks and providers, next to local or Ledger accounts, and pick the sender: [docs/user/guides/multiple-keys.md](docs/user/guides/multiple-keys.md)
- Turn on and read the debug output: [docs/user/guides/debug-output.md](docs/user/guides/debug-output.md)
- Deploy with Hardhat Ignition from a KMS account (choosing the deployer, rehearsing on a simulated network or a Sepolia fork, verifying the source on Blockscout and Sourcify when an explorer shows a "verified twin"): [docs/user/guides/deploy-with-ignition.md](docs/user/guides/deploy-with-ignition.md)
- Find who signed with a key after an incident or for an audit (turn on each cloud's audit log, read it with `kms history`, match sign events to transactions by sender, time and, on Google Cloud, digest, keep the log long enough): [docs/user/guides/who-signed.md](docs/user/guides/who-signed.md)
- Send a KMS address's balance back before deleting the key (the `scripts/return-funds.ts` script the tutorials run, and what it refuses): [docs/user/guides/return-funds.md](docs/user/guides/return-funds.md)
- A send failed with no clear answer (`-32000`, a gateway timeout), a transaction is not mined, or a nonce gap: look it up, compare the pending and latest counts, fill or replace a nonce: [docs/user/guides/uncertain-sends.md](docs/user/guides/uncertain-sends.md)
- Complete projects to copy, which deploy and call a contract with viem, ethers or Ignition: [examples/README.md](examples/README.md)
- Use a KMS key as the signer of an Alchemy Wallet APIs smart wallet (`connection.kms.getAccount` as the `@alchemy/wallet-apis` signer, what the key signs for EIP-7702 and user operations, a check script that sends nothing, a sponsored send): [docs/user/guides/alchemy-wallet-apis.md](docs/user/guides/alchemy-wallet-apis.md)
- Coming from Foundry: [docs/user/guides/migrate-from-foundry.md](docs/user/guides/migrate-from-foundry.md) and [docs/user/explanation/foundry-comparison.md](docs/user/explanation/foundry-comparison.md)
- How hardhat-kms compares with the Hardhat 2 `hardhat-kms-signer` packages and their forks (last release, Hardhat major, cloud, how each plugs in): [docs/user/explanation/other-kms-signers.md](docs/user/explanation/other-kms-signers.md)
- A KMS key or a private key in `.env` or the Hardhat keystore (what each protects against, what neither does, cost and latency per signature): [docs/user/explanation/kms-or-env-key.md](docs/user/explanation/kms-or-env-key.md)
- A KMS key or a Ledger with hardhat-ledger (unattended signing versus a device prompt, both in one project): [docs/user/explanation/kms-or-ledger.md](docs/user/explanation/kms-or-ledger.md)
- How a request goes from viem or ethers through the plugin to the KMS and the node: [docs/user/explanation/how-it-works.md](docs/user/explanation/how-it-works.md)
- Which credentials sign on a laptop, in CI and on a server, per cloud: [docs/user/explanation/cloud-access.md](docs/user/explanation/cloud-access.md)
- What the plugin protects against and what it does not, what to configure, and what happens when a KMS call times out: [docs/user/explanation/security-model.md](docs/user/explanation/security-model.md)
- Check that installed packages were built from a signed release tag (`npm audit signatures`, provenance, tag signature, tarball files): [docs/user/guides/verify-a-release.md](docs/user/guides/verify-a-release.md)
- What `latest` and `beta` mean, what a version number promises, the Hardhat and viem ranges per plugin major, and how long an old major gets security fixes: [docs/user/explanation/versioning.md](docs/user/explanation/versioning.md)
- Pages not written yet: [docs/contributor/documentation.md#planned-pages](docs/contributor/documentation.md#planned-pages)

Never ask a user to paste credentials, private keys or API-keyed RPC URLs. Credentials never come from the Hardhat config: AWS and Google Cloud keys use their SDK's credential discovery, and Azure keys use the plugin's own chain ([docs/user/guides/azure-key-vault-setup.md#3-sign-in](docs/user/guides/azure-key-vault-setup.md#3-sign-in)). API-keyed RPC URLs belong in `configVariable()`, which also accepts key identifiers.

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
pnpm run docs:check             # doc snippets typecheck, every page is indexed, generated pages are current, frontmatter and skills are valid, Mermaid blocks parse
pnpm run docs:errors            # regenerate docs/user/reference/errors.md from the error catalogues
pnpm run docs:api               # build, then regenerate docs/user/reference/api/ from TSDoc
pnpm run docs:site:check        # build the docs site from docs/ and check its output
```

Where things are:

- `packages/hardhat-kms`: the core plugin. Its public entry points are `hardhat-kms`, `hardhat-kms/types` (config and provider types) and `hardhat-kms/provider-utils` (helpers for provider plugins, `@experimental`).
- `packages/hardhat-kms-aws`: the AWS KMS provider plugin, which depends on `@aws-sdk/client-kms`.
- `packages/hardhat-kms-azure`: the Azure Key Vault provider plugin, which depends on `@azure/keyvault-keys` and `@azure/identity`.
- `packages/hardhat-kms-gcp`: the Google Cloud KMS provider plugin, which depends on `@google-cloud/kms`.
- `tools/api-docs`: a private package, never published, that runs TypeDoc on TypeScript 6 for the API reference ([decision 0012](docs/contributor/decisions/0012-api-reference-generator.md)).
- `tools/docs-site`: a private package, never published, that builds the docs site from `docs/` with VitePress; see [Documentation](docs/contributor/documentation.md#the-docs-site).
- `examples/`: Hardhat projects that deploy and call a contract from a KMS account with viem, ethers and Ignition. They are workspace members, and `pnpm run test:examples` runs them against LocalStack.

| Topic                                                       | Page                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Module map, code map, request flows                         | [docs/contributor/architecture.md](docs/contributor/architecture.md)                             |
| Signature checks, key pinning, threat model                 | [docs/contributor/signing-pipeline.md](docs/contributor/signing-pipeline.md)                     |
| Security checklist for signing, sending and release changes | [docs/contributor/security-review.md](docs/contributor/security-review.md)                       |
| Adapter interface, provider packages                        | [docs/contributor/providers.md](docs/contributor/providers.md)                                   |
| Transaction filling, nonces, send lock                      | [docs/contributor/transactions.md](docs/contributor/transactions.md)                             |
| Test layers and conventions                                 | [docs/contributor/testing.md](docs/contributor/testing.md)                                       |
| Transactions of the latest live run on Sepolia              | [docs/live-proof.md](docs/live-proof.md)                                                         |
| Quality gates, hooks, CI                                    | [docs/contributor/tooling.md](docs/contributor/tooling.md)                                       |
| Who releases, the signed tag, staging and promotion         | [docs/contributor/releasing.md](docs/contributor/releasing.md)                                   |
| How the docs are organised                                  | [docs/contributor/documentation.md](docs/contributor/documentation.md)                           |
| Why the main decisions were made                            | [docs/contributor/decisions/README.md](docs/contributor/decisions/README.md)                     |
| How other signers compare, and why each check exists        | [docs/contributor/research/signing-prior-art.md](docs/contributor/research/signing-prior-art.md) |
| Roadmap                                                     | [docs/contributor/roadmap.md](docs/contributor/roadmap.md)                                       |
| The 1.0.0 announcement text                                 | [docs/contributor/launch-notes/1.0.0.md](docs/contributor/launch-notes/1.0.0.md)                 |
| Adoption metrics, the monthly check                         | [docs/contributor/adoption-metrics.md](docs/contributor/adoption-metrics.md)                     |

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
- Never tag, publish, approve a GitHub environment, approve a staged package on npm, move a dist-tag, or dispatch `promote.yml`. A release is a maintainer's action; the process and the three workflows (`release-pr.yml`, `release.yml`, `promote.yml`), with `release-next.yml` for a future major, are in [docs/contributor/releasing.md](docs/contributor/releasing.md). A dry run of `release.yml` or `release-next.yml` publishes nothing and may be run to check a change to the release path: `gh workflow run release.yml --ref <your branch> -f dry-run=true -f tag=none`. GitHub dispatches only a workflow whose file is on `main`, so a branch that adds or renames `release.yml` cannot be dry-run before it merges.
- Never dispatch `live-tests.yml` and never add the `ci:live` label to a pull request. A live run signs with the real test keys, and the owner starts and approves each one; see [Live tests in GitHub Actions](docs/contributor/testing.md#live-tests-in-github-actions).
- Versions change only through `pnpm run version-packages`, on the Version Packages pull request. Never edit a manifest's `version` by hand.
- Tests come with the change, and coverage stays at or above 95%.
- Docs ship with the code: update the pages the change affects, and link any new page from this file and from [docs/README.md](docs/README.md).
- Do not edit `packages/hardhat-kms/src/internal/vendor/`. It is micro-eth-signer 0.19.0 code with only import paths changed; see [decision 0001](docs/contributor/decisions/0001-vendor-eip712-encoder.md).
- Before changing code that decides what gets signed (`packages/hardhat-kms/src/internal/crypto/`, `packages/hardhat-kms/src/internal/signer/`), read [docs/contributor/signing-pipeline.md](docs/contributor/signing-pipeline.md). A pull request that changes a path listed in [docs/contributor/security-review.md](docs/contributor/security-review.md) carries the ticked checklist items of each list it touches; the release workflows, release scripts and package manifests have their own list there.
- Never print or commit secrets, key ids from real accounts, or API-keyed RPC URLs, including in tests, logs and error messages.
- After changing a TSDoc comment or a public type of `hardhat-kms`, run `pnpm run docs:api`.
- Build every error from a catalogue entry (`src/internal/error-catalog.ts`) with `catalogError`, `catalogMessage` or `internalError`, then run `pnpm run docs:errors`. See [Errors](docs/contributor/architecture.md#errors).
- Do not silence the type checker or the linter in shipped code: no `any`, no `@ts-` directives, no casts to get past a type. Use a type guard, an assertion function with real checks, narrowing on a discriminant, or a parse function that returns the checked type. `pnpm run check` runs `scripts/check-type-escapes.ts`, which fails on any escape, type predicate or assertion function not listed with its count and reason in `scripts/type-escapes.json`.
