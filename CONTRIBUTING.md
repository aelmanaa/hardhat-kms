# Contributing

## Setup

Requirements: Node.js 24 (see `.nvmrc`; the package supports Node >= 22.13 at runtime) and npm.

```sh
npm install        # also installs the git hooks (lefthook)
npm run check      # format check, lint (type-aware) and typecheck
npm test           # unit + integration tests
npm run coverage   # tests with coverage thresholds
npm run pkg:check  # build + publint + arethetypeswrong + knip
```

## Workflow

- `main` only changes through pull requests (squash merge). The pre-push hook refuses direct pushes to `main`.
- Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org) (checked by the commit-msg hook).
- Every user-facing change needs a changeset: `npm run changeset`.
- The pre-commit hook formats (oxfmt) and lints (oxlint) staged files and typechecks the project.

## Code standards

- TypeScript 7, strict, `isolatedDeclarations`, `erasableSyntaxOnly`; relative imports use `.ts` extensions.
- Every exported symbol has TSDoc (enforced by lint).
- No `process.env` reads outside the few documented places (enforced by lint).
- Errors are `HardhatPluginError`s built from an allow-list of fields; never include credentials or raw SDK errors.
- Tests: `test/unit` (pure, fast), `test/integration` (real Hardhat runtime), `test/localstack` (emulated AWS KMS), `test/live` (real clouds, manual only).

See `docs/DESIGN.md` for the architecture and `docs/adding-a-provider.md` for adding a KMS/HSM provider.
