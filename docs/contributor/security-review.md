# Security review of pull requests

Audience: Contributors and reviewers of a pull request that changes how the plugin signs or sends, or what gets published and how.

Status: the checklist is in the pull request template, and the `Security checklist` job of `pr-hygiene.yml` enforces it.

This page holds two lists of paths, each with its own checklist items:

- [Signing and sending](#signing-and-sending): the code that decides which key signs, what bytes it signs and what reaches the node.
- [Release and supply chain](#release-and-supply-chain): the files that decide what gets published to npm, who can publish it, and what the release gate checks first.

A pull request that changes a path of a list carries that list's items from the security checklist of the [pull request template](../../.github/pull_request_template.md), with every one ticked. A pull request that changes paths of both lists carries both sets of items. Each item states one property the change must keep. The author ticks it before asking for review, and the reviewer checks it against the diff. The checklist does not prove that a second person read the change. It records which questions were asked and answered, so a later reader can see how a change to these paths was reviewed.

Tick an item when the change keeps that property, or when it does not touch it; say which in the description when it is not obvious from the diff. Each item names the property to check and where the design states it.

The paths are glob patterns relative to the repository root: `*` matches within one directory, `**` matches any number of directories. A renamed file counts under its old and its new path.

## Signing and sending

The design these questions protect is in [Signing pipeline and security](signing-pipeline.md), including its [threat model](signing-pipeline.md#threat-model-summary), and in [Transactions](transactions.md). Release workflows, release scripts and package manifests are on the [release and supply chain list](#release-and-supply-chain).

```text
packages/hardhat-kms/src/internal/crypto/**
packages/hardhat-kms/src/internal/signer/**
packages/hardhat-kms/src/internal/rpc/**
packages/hardhat-kms/src/internal/providers/**
packages/hardhat-kms/src/internal/viem/**
packages/hardhat-kms/src/internal/vendor/**
packages/hardhat-kms/src/internal/hook-handlers/network.ts
packages/hardhat-kms/src/internal/tasks/sign.ts
packages/hardhat-kms/src/internal/tasks/sign-tx.ts
packages/hardhat-kms/src/internal/tasks/sign-auth.ts
packages/hardhat-kms/src/internal/config/**
packages/hardhat-kms/src/internal/debug.ts
packages/hardhat-kms/src/internal/errors.ts
packages/hardhat-kms/src/internal/error-catalog.ts
packages/hardhat-kms/src/internal/warnings.ts
packages/hardhat-kms/src/provider-utils.ts
packages/hardhat-kms-*/src/internal/adapter.ts
packages/hardhat-kms-*/src/internal/hook-handlers/kms.ts
packages/hardhat-kms-aws/src/internal/client-settings.ts
packages/hardhat-kms-azure/src/internal/credential.ts
packages/hardhat-kms-gcp/src/internal/wire.ts
```

What each group decides:

| Area                    | Paths                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Key identity            | the three adapters and their `kms` hook handlers, `providers/`, `config/`, the AWS client settings, the Azure credential |
| Signed bytes            | `crypto/`, `vendor/`, `rpc/transactions.ts`, `rpc/transaction-filler.ts`, `rpc/typed-data.ts`, `viem/`, the sign tasks   |
| Checks on each response | `signer/kms-signer.ts`, `provider-utils.ts`, the GCP wire checksums                                                      |
| Timeouts                | `signer/timeout.ts`, the adapters                                                                                        |
| Sending and retries     | `rpc/dispatcher.ts`, `rpc/send-guard.ts`, `rpc/chain-id.ts`                                                              |
| Lifecycle               | `hook-handlers/network.ts`, `signer/key-cache.ts`                                                                        |
| Errors and logs         | `errors.ts`, `error-catalog.ts`, `debug.ts`, `warnings.ts`, `config/identifiers.ts` (masking)                            |

Tests and docs are not listed; they do not run when the plugin signs or sends.

### Signing and sending items

| Item                   | The change keeps this true                                                                                                                                                                                                                            | Design                                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key                    | The configured key signs, and no other. Each provider's identity checks still run on every response, and the `address` pin is checked before a public key is cached or a signature released.                                                          | [Key identity and pinning](signing-pipeline.md#key-identity-and-pinning)                                                                           |
| Signed bytes           | The plugin signs the digest it built from its own copy of the request. Every signature passes the pipeline in `kms-signer.ts`, a transaction's `recoverSender` equals `from`, and the chain-id checks still apply. No RPC method signs a bare digest. | [Signature pipeline](signing-pipeline.md#signature-pipeline), [Copies](transactions.md#copies), [Chain-id checks](transactions.md#chain-id-checks) |
| What the node receives | A KMS transaction reaches the node only as `eth_sendRawTransaction` with bytes the plugin signed and checked, through one `next` call per send. No unsigned KMS transaction passes on to Hardhat's sender handlers.                                   | [Signing and sending](transactions.md#signing-and-sending), [Sender resolution](transactions.md#sender-resolution)                                 |
| Late or lost answers   | A KMS call stops at `timeoutMs` and its late answer is never used. A broadcast without an answer throws the -32000 error with the hash. One request never fills or signs again after its broadcast, and a retry entry resends the same bytes.         | [Retries after broadcast](transactions.md#retries-after-broadcast)                                                                                 |
| Send lock and nonces   | Each send from a KMS key runs inside `withSendLock`, and its limits still fail before anything is signed. The high-water mark moves only when the node is known to have the transaction.                                                              | [Nonces and the send lock](transactions.md#nonces-and-the-send-lock)                                                                               |
| Lifecycle              | Closing a connection drops its filler, sends and timers. The signer cache's idle close waits for signing in flight. No timer keeps the process alive.                                                                                                 | [Lifetimes and caching](architecture.md#lifetimes-and-caching)                                                                                     |
| Errors and logs        | Errors come from a catalogue entry with allow-listed fields. No credential, raw SDK error, node URL or the value behind a masked identifier reaches an error, the `debug` output or a warning.                                                        | [Errors, logs and secrets](signing-pipeline.md#errors-logs-and-secrets)                                                                            |
| Tests                  | Tests cover the changed behaviour, including its failure path. A change to code that Stryker mutates passes `pnpm run test:mutation` at or above its `break` score.                                                                                   | [Testing strategy](testing.md#testing-strategy)                                                                                                    |

## Release and supply chain

The design these questions protect is in [Releasing](releasing.md), including [who can release](releasing.md#1-who-can-release), and in [decision 0016](decisions/0016-release-process.md). The code that signs and sends is on the [signing and sending list](#signing-and-sending).

```text
.github/workflows/release.yml
.github/workflows/release-next.yml
.github/workflows/release-stage.yml
.github/workflows/release-pr.yml
.github/workflows/promote.yml
.github/workflows/live-tests.yml
.github/workflows/pr-hygiene.yml
.github/release-keys/**
.github/ruleset-*.json
.github/CODEOWNERS
packages/*/package.json
scripts/registry.ts
scripts/check-packages.ts
scripts/check-tarballs.ts
scripts/verify-release-tag.ts
scripts/release-trigger.ts
scripts/release-channel.ts
scripts/release-gate-ci.ts
scripts/ci-all-os-decide.ts
scripts/registry-release.ts
scripts/check-registry-release.ts
scripts/check-live-rule.ts
scripts/consumer-typecheck.ts
scripts/test-peer-installs.ts
scripts/check-fresh-install.ts
scripts/check-deprecated-packages.ts
scripts/pack.ts
scripts/ast.ts
scripts/temporary-install.ts
package.json
pnpm-workspace.yaml
scripts/security-checklist.ts
test/scripts/security-checklist.test.ts
docs/contributor/security-review.md
.github/pull_request_template.md
```

What each group decides:

| Area                                 | Paths                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What gets published                  | the package manifests (`files`, `exports`, `bin`, lifecycle scripts, dependencies), the root `package.json` (`pkg:check`, `version-packages`), `pnpm-workspace.yaml` (which dependency install scripts run, the build tool versions), `registry.ts`, `check-packages.ts`, `check-tarballs.ts`, and the helpers they import (`pack.ts`, `ast.ts`, `temporary-install.ts`)                                                                                                                                      |
| Who can publish                      | `release.yml`, `release-next.yml`, the jobs both call in `release-stage.yml`, and `promote.yml` (their environments and `id-token: write`), `release-keys/`, the rulesets, `CODEOWNERS`                                                                                                                                                                                                                                                                                                                       |
| What the release gate checks         | `verify-release-tag.ts`, `release-trigger.ts`, `release-channel.ts` (which versions, branch and dist-tag each channel takes), `release-gate-ci.ts`, `ci-all-os-decide.ts`, `check-registry-release.ts`, `registry-release.ts`, `check-live-rule.ts`, `check-fresh-install.ts` (the release workflow's `fresh-install` job) with the `ALLOWED` list it imports from `check-deprecated-packages.ts`, and the checks `promote.yml` runs before `latest` moves (`consumer-typecheck.ts`, `test-peer-installs.ts`) |
| Workflows with write or cloud access | `release-pr.yml` (writes the Version Packages pull request), `live-tests.yml` (OIDC tokens for the three clouds)                                                                                                                                                                                                                                                                                                                                                                                              |
| The security checklist itself        | `pr-hygiene.yml`, `security-checklist.ts` and its test, this page, the pull request template                                                                                                                                                                                                                                                                                                                                                                                                                  |

The CI workflows whose runs `release-gate-ci.ts` counts (`ci.yml`, `ci-all-os.yml`, `hardhat-versions.yml`, `sdk-floors.yml`) and the lockfile are not listed: most pull requests change them, and a reviewer reads those changes as CI changes. The release pull request (`changeset-release/main`) changes the manifests on every release; the job skips it when its branch is in this repository.

### Release and supply chain items

| Item                         | The change keeps this true                                                                                                                                                                                                                                                                                                                                       | Design                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| What gets published          | The four tarballs hold only the files each manifest's `files` field allows, built from the tagged commit, and `check-tarballs.ts` still checks each name, version, `gitHead` and SHA-256 sum before publishing. A new dependency, lifecycle script or `bin` entry is named in the description.                                                                   | [Cut a release](releasing.md#3-cut-a-release)                                                          |
| Who can publish              | Only a signed `vX.Y.Z` tag, or a `vX.Y.Z-next.N` tag on the `next` branch, that a repository admin pushes starts a release, and the `npm-publish` and `npm-latest` environment approvals and the stage approval on npmjs.com still stand. No job gains `id-token: write`, a secret or a write permission it does not need, and every action stays pinned by SHA. | [Who can release](releasing.md#1-who-can-release)                                                      |
| What the release gate checks | Every check that `release.yml`, `release-next.yml` and `promote.yml` run before publishing or moving `latest` still runs, and still fails when it cannot get an answer (a missing run, an API error). The lists on this page, the template and `security-checklist.ts` are still read from the base branch.                                                      | [Cut a release](releasing.md#3-cut-a-release), [Verify and promote](releasing.md#4-verify-and-promote) |

## How the check works

The `Security checklist` job of `pr-hygiene.yml` runs `scripts/security-checklist.ts` on every pull request, and again when its description is edited. It reads the changed files from the GitHub API and the description from the event. It reads this page, the template and the script from the base branch, so a pull request cannot change them for its own run; a change to a list applies to the pull requests after it merges. The workflow file itself runs as the pull request has it, which is why `pr-hygiene.yml` and the script are on the release and supply chain list: a pull request that changes them carries that list's items.

The template's `## Security checklist` section has one `###` heading per list, named like the list's `##` section on this page, with the list's items below it. The job checks each list on its own:

- No path of any list changed: the job passes and asks for nothing.
- Paths of one or both lists changed: the job passes when the description has the `## Security checklist` section with every item of those lists ticked. Items of a list whose paths did not change are not required, so delete them or leave them unticked. A missing section, a missing item or an unticked box fails the job, and the log names the changed paths of each list and each item that is missing or unticked.
- The API answers with fewer files than the pull request changed (it lists at most 3000): the job fails, because an unlisted file could be on a list.
- The lists on this page and the `###` headings of the template do not match one to one, or a heading has no items: the job fails, so a list cannot drop out of the check unnoticed. A list on this page is a `##` section whose first code block opens with ` ```text `.

The job skips Dependabot's pull requests, including commits a maintainer pushes onto a Dependabot branch; review those as you would a release change when they touch a listed path.

Items are matched by their bold label anywhere in the section, so the `###` headings may stay or go, and a note after the label is fine: `- [x] **Key.** Not touched: the change only renames a log line.`

`test/scripts/security-checklist.test.ts` tests the path matching, the parsing of the description and the template, which lists a set of changed files requires, and the command's exit codes. It also checks that every pattern on this page matches a file in the repository, so a pattern that names a moved or deleted file fails the test.

## Change the lists

Add a path to the signing and sending list when a new file decides which key signs, what bytes it signs, what reaches the node, or what an error or log line can contain. Add one to the release and supply chain list when a new file decides what gets published, who can publish, or what the release gate checks. Remove a path only together with the code it named. Changes go through a pull request like any other, and a new list applies once it is on `main`. A new list takes a `##` section on this page with its ` ```text ` block, a `###` heading of the same name with its items in the template, and its name in the real-repository test of `test/scripts/security-checklist.test.ts`, which pins the list names.
