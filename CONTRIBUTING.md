# Contributing

## Setup

Requirements: Node.js 24 (see `.nvmrc`) and pnpm. Install pnpm with `npm i -g pnpm`; it then runs the version pinned in `packageManager`. Development needs Node >= 22.18, which runs the TypeScript scripts and hooks natively; the published packages support Node >= 22.13. To run the tests on 22.13 anyway, see [Run the tests on the published floor](docs/contributor/testing.md#run-the-tests-on-the-published-floor). Installing the package from git is not supported; use the npm release. Releases are published from CI only, with npm provenance.

The repository is a pnpm workspace ([decision 0010](docs/contributor/decisions/0010-pnpm-workspaces.md)). The core plugin is in `packages/hardhat-kms`, and each cloud provider has its own package beside it ([decision 0009](docs/contributor/decisions/0009-one-package-per-provider.md)): `packages/hardhat-kms-aws`, `packages/hardhat-kms-gcp` and `packages/hardhat-kms-azure`. Run the commands below from the repository root; they cover every package.

```sh
pnpm install                    # also installs the git hooks (lefthook)
pnpm run check                  # format, type-aware lint, typecheck, no type escapes
pnpm test                       # unit + integration tests
pnpm run test:localstack        # AWS adapter against LocalStack (needs Docker)
pnpm run test:examples          # the projects in examples/ against LocalStack (needs Docker)
pnpm run test:sdk-floors        # provider packages against their lowest SDK versions
pnpm run test:hardhat-versions  # fill tests on the Hardhat floor and latest 3.x
pnpm run test:mutation          # Stryker on the core's crypto/ and signer/ (incremental)
pnpm run test:live              # deploys, sends and signs with each configured key on a Sepolia fork (needs anvil)
pnpm run test:live:aws          # AWS adapter against real KMS (needs HARDHAT_KMS_LIVE_AWS_KEY_ID)
pnpm run coverage               # tests with coverage thresholds
pnpm run pkg:check              # build + publint + arethetypeswrong + knip
pnpm run docs:check             # doc snippets typecheck, every page is indexed, generated pages are current, Mermaid blocks parse
pnpm run docs:api               # regenerate the API reference after changing TSDoc or a public type
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
- Every user-facing change needs a changeset: `pnpm changeset`. See [Changesets](#changesets) for what to write in it.
- The pre-commit hook formats (oxfmt) and lints (oxlint) staged files and typechecks the project.

### Changesets

A changeset is a release note. From 1.0.0, its text becomes the `CHANGELOG.md` entry and the GitHub Release body. The reader is an operator who signs with production keys and skims the changelog for the one entry that affects them. They read it once and know what changed for them. Reasoning, design and mechanism go in the commit body or the pull request.

- Lead with what the user sees. The first sentence names the task, option, config key or behaviour that changed, and how. If the mechanism matters to the user, give it a sentence of its own. If it does not, leave it out.
- One idea per sentence. Split any sentence a reader would have to read twice. Do not chain changes with colons, semicolons or parentheses.
- End with the issue link. If the reader needs the old behaviour to recognise the bug, give it a past-tense sentence of its own. Do not append "instead of ..." or "rather than ..." to a sentence.
- Plain punctuation: no em or en dashes, no bold or italics for emphasis, straight quotes. Plain words. Name the actor when it matters: "`kms sign-tx` now refuses", not "is now refused".
- No reasoning. A changeset states what the plugin does now. Design justification, "so that ..." chains, "note that" and hedging go in the commit body or the pull request.
- A breaking or behaviour change carries a second paragraph that starts with "What should I do?" and names the config key, task or command to change.
- A Hardhat, Node.js or SDK floor change states the new floor in the entry.
- A security fix names the advisory and the affected version range.
- Which bump: `patch` for a fix or a docs-only change to a published file, such as a package README; `minor` for a new task, option, config key or provider capability; `major` for a removed or renamed one, a dropped Hardhat major or an error code removed from the catalogue. The four packages are one fixed group and get the same version, so name only the packages whose changelog should carry the entry.
- A change under `packages/` with nothing to tell users, such as tests or an internal refactor, gets an empty changeset: `pnpm changeset add --empty`. A pull request that changes `packages/` carries one or the other.
- Before committing, reread the entry and ask what makes it read as generated. The usual answers are a dash, an "instead of" tail, and a colon-joined list of internals.

An entry that follows the rules:

```md
---
"hardhat-kms": minor
"@hardhat-kms/aws": minor
---

An AWS key's `profile` and `region`, and `kms.defaults.aws.region`, now take `configVariable(...)` as well as a literal string. The plugin reads the variable when the key is first used. An empty value leaves the field unset, so `configVariable("AWS_KMS_PROFILE", { default: "" })` makes the profile optional. An unset variable without a `default` fails at first use with Hardhat's error, which names the variable. A key ARN whose region conflicts with a `region` from a variable fails at first use. Errors, `kms accounts` and `kms history` show a value from a variable as `<VARIABLE_NAME>` or `<hidden>` unless `--show-ids` is given.

What should I do? Nothing changes in a config that uses literal strings. In the resolved config, `AwsKmsKeyConfig.region`, `AwsKmsKeyConfig.profile` and `KmsConfig.defaults.aws.region` are now `KmsIdentifier` values. A plugin that reads one of them should call `await key.region?.get()` and print `key.region?.display`. The `kms accounts` report keeps `region` and `profile` as strings.

Issue: [#243](https://github.com/aelmanaa/hardhat-kms/issues/243)
```

## Code standards

- TypeScript 7, strict, `isolatedDeclarations`, `erasableSyntaxOnly`; relative imports use `.ts` extensions.
- Every exported symbol has TSDoc (enforced by lint).
- After changing a TSDoc comment or a public type of `hardhat-kms`, run `pnpm run docs:api` and commit the pages it writes in `docs/user/reference/api/`; `pnpm run docs:check` fails until you do. The generator runs TypeDoc on TypeScript 6 from `tools/api-docs` ([decision 0012](docs/contributor/decisions/0012-api-reference-generator.md)); the rest of the workspace stays on TypeScript 7.
- No `process.env` reads outside the few documented places (enforced by lint).
- Errors are `HardhatPluginError`s built from an allow-list of fields; never include credentials or raw SDK errors. Each one comes from an entry of the package's error catalogue; see [Errors](docs/contributor/architecture.md#errors).
- Tests: each package has `test/unit` (pure, fast) and `test/integration` (real Hardhat runtime; for a provider package, also its real SDK against a local endpoint). `@hardhat-kms/aws` also has `test/localstack`, run with `pnpm run test:localstack` (needs Docker), and `test/examples`, which runs the projects in [examples/](examples/) against LocalStack with `pnpm run test:examples`. It also has `test/live`, a smoke test against real KMS, run with `pnpm run test:live:aws` and skipped unless `HARDHAT_KMS_LIVE_AWS_KEY_ID` is set. `@hardhat-kms/azure` has the same, run with `pnpm run test:live:azure` and skipped unless `HARDHAT_KMS_LIVE_AZURE_KEY_ID` holds a versioned key URL. `@hardhat-kms/gcp` has the same for Google Cloud KMS, run with `pnpm run test:live:gcp` and skipped unless `HARDHAT_KMS_LIVE_GCP_KEY` names a key version. The live tests are in `test/live` at the repository root, run with `pnpm run test:live`. They read the same three key variables and skip each provider whose variable is not set. By default they run on a local anvil fork of Sepolia, which funds each key's address and spends nothing; `HARDHAT_KMS_LIVE_NETWORK=sepolia` runs them on Sepolia itself, which needs Sepolia ETH on each address and is for before a release and after changes to signing or sending. [Testing](docs/contributor/testing.md) lists what they check and what each mode proves, and [docs/live-proof.md](docs/live-proof.md) records the latest Sepolia run.

See [docs/contributor/architecture.md](docs/contributor/architecture.md) for how the code fits together, and [docs/README.md](docs/README.md) for all docs. [AGENTS.md](AGENTS.md) is the same index for coding agents. To add a KMS or HSM provider, see [docs/contributor/providers.md](docs/contributor/providers.md).
