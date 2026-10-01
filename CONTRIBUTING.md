# Contributing

## Setup

Requirements: Node.js 24 (see `.nvmrc`) and pnpm. Install pnpm with `npm i -g pnpm`; it then runs the version pinned in `packageManager`. Development needs Node >= 22.18, which runs the TypeScript scripts and hooks natively; the published packages support Node >= 22.13. Installing the package from git is not supported; use the npm release. Releases are published from CI only, with npm provenance.

The repository is a pnpm workspace ([decision 0010](docs/contributor/decisions/0010-pnpm-workspaces.md)). The core plugin is in `packages/hardhat-kms`, and each cloud provider has its own package beside it ([decision 0009](docs/contributor/decisions/0009-one-package-per-provider.md)): `packages/hardhat-kms-aws` today, Google Cloud and Azure in M6. Run the commands below from the repository root; they cover every package.

```sh
pnpm install                    # also installs the git hooks (lefthook)
pnpm run check                  # format, type-aware lint, typecheck, no type escapes
pnpm test                       # unit + integration tests
pnpm run test:localstack        # AWS adapter against LocalStack (needs Docker)
pnpm run test:examples          # the projects in examples/ against LocalStack (needs Docker)
pnpm run test:sdk-floors        # provider packages against their lowest SDK versions
pnpm run test:hardhat-versions  # fill tests on the Hardhat floor and latest 3.x
pnpm run test:live:aws          # AWS adapter against real KMS (needs HARDHAT_KMS_LIVE_AWS_KEY_ID)
pnpm run coverage               # tests with coverage thresholds
pnpm run pkg:check              # build + publint + arethetypeswrong + knip
pnpm run docs:check             # doc snippets typecheck, every page is indexed
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
- Tests: each package has `test/unit` (pure, fast) and `test/integration` (real Hardhat runtime; for a provider package, also its real SDK against a local endpoint). `hardhat-kms-aws` also has `test/localstack`, run with `pnpm run test:localstack` (needs Docker), and `test/examples`, which runs the projects in [examples/](examples/) against LocalStack with `pnpm run test:examples`. It also has `test/live`, a smoke test against real KMS, run with `pnpm run test:live:aws` and skipped unless `HARDHAT_KMS_LIVE_AWS_KEY_ID` is set. The full live tests arrive with the live-test milestone.

See [docs/contributor/architecture.md](docs/contributor/architecture.md) for how the code fits together, and [docs/README.md](docs/README.md) for all docs. [AGENTS.md](AGENTS.md) is the same index for coding agents. To add a KMS or HSM provider, see [docs/contributor/providers.md](docs/contributor/providers.md).
