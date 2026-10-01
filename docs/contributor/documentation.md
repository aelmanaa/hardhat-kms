# Documentation

Audience: Anyone writing or reviewing hardhat-kms docs.

Status: The structure and rules apply now. The pages under [Planned pages](#planned-pages) arrive with their issues.

User docs follow the Diátaxis split: each page is a tutorial, a how-to guide, reference or explanation, and does only that job. Contributor docs and decision records live in a separate tree.

| Kind        | Answers                       | Where                         |
| ----------- | ----------------------------- | ----------------------------- |
| Tutorial    | "Show me, start to finish."   | `docs/user/tutorials/`        |
| How-to      | "How do I do this one thing?" | `docs/user/guides/`           |
| Reference   | "What exactly does X accept?" | `docs/user/reference/`        |
| Explanation | "Why does it work this way?"  | `docs/user/explanation/`      |
| Contributor | "How is the code built?"      | `docs/contributor/`           |
| Decision    | "Why was it done this way?"   | `docs/contributor/decisions/` |

## Rules

- Docs ship with the code. A feature's issue lists the pages it adds or changes, and its pull request includes them.
- Every page states its audience. A page about planned behaviour states which milestone delivers it.
- Every page is linked from [docs/README.md](../README.md) and from [AGENTS.md](../../AGENTS.md). Decision records are linked from the [decision index](decisions/README.md) instead of docs/README.md.
- Every exported symbol has TSDoc, enforced by lint.
- Examples use the real API and must run. The live tests (M9) run each tutorial's steps on Sepolia.
- Never put credentials, real key ids or API-keyed RPC URLs in docs. Use placeholders such as `alias/deployer` and `configVariable("SEPOLIA_RPC_URL")`.

## Checks

`pnpm run docs:check` runs `scripts/check-docs.ts`, locally and in the CI Docs job. It checks two things:

- Every TypeScript snippet (` ```ts `, ` ```typescript ` or a `~~~` fence) in `README.md`, each `packages/*/README.md` and `docs/` typechecks as its own program, with strict settings, against the built packages: `hardhat-kms`, `hardhat-kms-aws` and `hardhat-kms-azure` resolve from the root's dependencies through each package's `exports`, as they do in a user's project, so a missing export fails the check. The root also lists `@nomicfoundation/hardhat-ignition` and `@nomicfoundation/hardhat-ignition-viem` as development dependencies, only for the snippets of the [Ignition guide](../user/guides/deploy-with-ignition.md); knip ignores them. Errors point at the Markdown file and line; a compiler failure without errors fails the check too. To exclude a snippet that is not meant to compile, such as a sketch of a planned API, put `<!-- docs-check: skip -->` on its own line before it.
- Every page under `docs/` is linked as the [rules](#rules) require. Decision records need the `AGENTS.md` link and a line in the decision index instead of `docs/README.md`; `docs/DESIGN.md` only needs the `AGENTS.md` link; the decision template is exempt. Only real links count, not paths in code or HTML comments.

[lychee](https://lychee.cli.rs) checks links, configured by `lychee.toml`. On every pull request the CI Docs job checks internal links and `#anchors` offline. A weekly workflow, `.github/workflows/docs-links.yml`, also checks external links, so a website that is briefly down cannot block a merge. To run the pull request check locally from the repository root:

```sh
docker run --rm -v "$PWD:/repo" -w /repo lycheeverse/lychee:0.24.2 --offline --config lychee.toml README.md AGENTS.md CLAUDE.md CONTRIBUTING.md SECURITY.md packages/hardhat-kms/THIRD_PARTY_NOTICES.md .github/pull_request_template.md 'packages/*/README.md' 'examples/README.md' 'examples/*/README.md' 'docs/**/*.md'
```

## Planned pages

The tracking issue for docs is [#38](https://github.com/aelmanaa/hardhat-kms/issues/38). Pages that do not exist yet:

- Tutorials: first deploy on Sepolia with AWS KMS ([#65](https://github.com/aelmanaa/hardhat-kms/issues/65)), Google Cloud KMS ([#66](https://github.com/aelmanaa/hardhat-kms/issues/66)) and Azure Key Vault ([#67](https://github.com/aelmanaa/hardhat-kms/issues/67)).
- Guides: GitHub Actions with OIDC ([#68](https://github.com/aelmanaa/hardhat-kms/issues/68)), multiple keys ([#69](https://github.com/aelmanaa/hardhat-kms/issues/69)), key rotation ([#70](https://github.com/aelmanaa/hardhat-kms/issues/70)), loss of access to a key ([#71](https://github.com/aelmanaa/hardhat-kms/issues/71)).
- Reference: errors ([#72](https://github.com/aelmanaa/hardhat-kms/issues/72)), public API ([#73](https://github.com/aelmanaa/hardhat-kms/issues/73)).
- Explanation: how it works, security model ([#39](https://github.com/aelmanaa/hardhat-kms/issues/39)).
- Contributor: adding a provider ([#40](https://github.com/aelmanaa/hardhat-kms/issues/40)).
- Docs checks in CI ([#63](https://github.com/aelmanaa/hardhat-kms/issues/63)), a docs site with `llms.txt` ([#74](https://github.com/aelmanaa/hardhat-kms/issues/74)).
