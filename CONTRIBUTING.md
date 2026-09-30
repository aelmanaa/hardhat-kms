# Contributing

## Setup

Requirements: Node.js 24 (see `.nvmrc`) and pnpm (`npm i -g pnpm`; it switches to the version pinned in `packageManager`). Development needs Node >= 22.18, which runs the TypeScript scripts and hooks natively; the published packages support Node >= 22.13.

The repository is a pnpm workspace ([decision 0010](docs/contributor/decisions/0010-pnpm-workspaces.md)). Packages live in `packages/`: `packages/hardhat-kms` is the core plugin. Commands at the root run across every package. Installing the package from git is not supported; use the npm release. Releases are published from CI only, with npm provenance.

```sh
pnpm install        # also installs the git hooks (lefthook)
pnpm run check      # format check, lint (type-aware) and typecheck
pnpm test           # unit + integration tests
pnpm run coverage   # tests with coverage thresholds
pnpm run pkg:check  # build + publint + arethetypeswrong + knip
pnpm run docs:check # doc snippets typecheck, every page is indexed
```

## Issues first

Every change starts from an issue, and every pull request links it with a closing keyword (`Closes #12`) or a reference (`Refs #12`). A CI check enforces the link; Dependabot pull requests are exempt.

Maintainers triage each issue before work starts. A triaged issue has:

- one type: `type:feature`, `type:bug`, `type:docs`, `type:test`, `type:chore`, `type:refactor`, or `type:epic` for a milestone tracker;
- one priority: `priority:P0` (blocking or a security problem), `P1` (on the critical path to the next release), `P2` (needed, not blocking), `P3` (later);
- a size (`size:S`, `M`, `L`) and at least one `area:*` label;
- a milestone. Milestone epics list their work as sub-issues.

Issues that affect what gets signed, keys or secrets also get `security`. New issues arrive with `status:needs-triage`.

## Workflow

- `main` only changes through pull requests (squash merge). The pre-push hook refuses direct pushes to `main`.
- Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org) (checked by the commit-msg hook).
- Every user-facing change needs a changeset: `pnpm changeset`.
- The pre-commit hook formats (oxfmt) and lints (oxlint) staged files and typechecks the project.

## Code standards

- TypeScript 7, strict, `isolatedDeclarations`, `erasableSyntaxOnly`; relative imports use `.ts` extensions.
- Every exported symbol has TSDoc (enforced by lint).
- No `process.env` reads outside the few documented places (enforced by lint).
- Errors are `HardhatPluginError`s built from an allow-list of fields; never include credentials or raw SDK errors.
- Tests: `packages/hardhat-kms/test/unit` (pure, fast) and `packages/hardhat-kms/test/integration` (real Hardhat runtime). Emulated AWS KMS tests (`packages/hardhat-kms/test/localstack`) and live cloud tests (`packages/hardhat-kms/test/live`) arrive with the AWS adapter and the live-test milestone.

See [docs/contributor/architecture.md](docs/contributor/architecture.md) for how the code fits together, and [docs/README.md](docs/README.md) for all docs. [AGENTS.md](AGENTS.md) is the same index for coding agents. A guide to adding a KMS or HSM provider will ship with the first provider.
