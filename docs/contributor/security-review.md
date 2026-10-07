# Security review of pull requests

Audience: Contributors and reviewers of a pull request that changes how the plugin signs or sends.

Status: the checklist is in the pull request template, and the `Security checklist` job of `pr-hygiene.yml` enforces it.

A pull request that changes a path listed below carries the security checklist of the [pull request template](../../.github/pull_request_template.md), with every item ticked. Each item states one property the change must keep. The author ticks it before asking for review, and the reviewer checks it against the diff. The checklist does not prove that a second person read the change. It records which questions were asked and answered, so a later reader can see how a change to these paths was reviewed.

The design these questions protect is in [Signing pipeline and security](signing-pipeline.md), including its [threat model](signing-pipeline.md#threat-model-summary), and in [Transactions](transactions.md).

## Listed paths

The paths are glob patterns relative to the repository root: `*` matches within one directory, `**` matches any number of directories.

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
| Errors and logs         | `errors.ts`, `debug.ts`, `warnings.ts`, `config/identifiers.ts` (masking)                                                |

A renamed file counts under its old and its new path. Tests, docs and workflows are not listed; they do not run when the plugin signs or sends.

## Checklist items

Each item names the property to check and where the design states it. Tick an item when the change keeps that property, or when it does not touch it; say which in the description when it is not obvious from the diff.

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

## How the check works

The `Security checklist` job of `pr-hygiene.yml` runs `scripts/security-checklist.ts` on every pull request, and again when its description is edited. It reads the changed files from the GitHub API and the description from the event. It reads this page, the template and the script from the base branch, so a pull request cannot change them for its own run; a change to the list applies to the pull requests after it merges. The workflow file itself runs as the pull request has it, so a pull request that changes `pr-hygiene.yml` gets reviewed for that change too.

- No listed path changed: the job passes and asks for nothing.
- A listed path changed: the job passes when the description has the `## Security checklist` section with every item of the template ticked. A missing section, a missing item or an unticked box fails the job, and the log names the listed paths that changed and each item that is missing or unticked.
- The API answers with fewer files than the pull request changed (it lists at most 3000): the job fails, because an unlisted file could be on the list.

Items are matched by their bold label, so a note after the label is fine: `- [x] **Key.** Not touched: the change only renames a log line.`

`test/scripts/security-checklist.test.ts` tests the path matching, the parsing of the description and the template, and the command's exit codes. It also checks that every pattern on this page matches a file in the repository, so a pattern that names a moved or deleted file fails the test.

## Change the list

Add a path when a new file decides which key signs, what bytes it signs, what reaches the node, or what an error or log line can contain. Remove a path only together with the code it named. Both changes go through a pull request like any other, and the new list applies once it is on `main`.
