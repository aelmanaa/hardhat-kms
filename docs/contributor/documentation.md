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
- The provider tutorials share one shape. [First deploy on Sepolia with AWS KMS](../user/tutorials/first-deploy-aws.md) is the template: an HTML comment at its top lists the parts the other providers copy as they are and the parts they rewrite.
- Examples use the real API and must run. The live tests (M9) run each tutorial's steps on Sepolia.
- Never put credentials, real key ids or API-keyed RPC URLs in docs. Use placeholders such as `alias/deployer` and `configVariable("SEPOLIA_RPC_URL")`.

## Checks

`pnpm run docs:check` runs `scripts/check-docs.ts`, locally and in the CI Docs job. It checks five things:

- Every TypeScript snippet (` ```ts `, ` ```typescript ` or a `~~~` fence) in `README.md`, each `packages/*/README.md` and `docs/`, apart from the generated API pages, typechecks as its own program, with strict settings, against the built packages: `hardhat-kms`, `hardhat-kms-aws`, `hardhat-kms-azure` and `hardhat-kms-gcp` resolve from the root's dependencies through each package's `exports`, as they do in a user's project, so a missing export fails the check. The root also lists `@nomicfoundation/hardhat-ignition` and `@nomicfoundation/hardhat-ignition-viem` as development dependencies, only for the snippets of the [Ignition guide](../user/guides/deploy-with-ignition.md), and `@nomicfoundation/hardhat-toolbox-viem`, only for the tutorials' configs, which start from Hardhat's viem template; knip ignores them. Errors point at the Markdown file and line; a compiler failure without errors fails the check too. To exclude a snippet that is not meant to compile, such as a sketch of a planned API, put `<!-- docs-check: skip -->` on its own line before it.
- Every page under `docs/` is linked as the [rules](#rules) require. Decision records need the `AGENTS.md` link and a line in the decision index instead of `docs/README.md`; `docs/DESIGN.md` only needs the `AGENTS.md` link; the decision template is exempt. The generated API pages need a link from their own index, `docs/user/reference/api/README.md`, which the two indexes link. Only real links count, not paths in code or HTML comments.
- The [errors reference](../user/reference/errors.md) matches the error catalogues. `scripts/generate-errors-doc.ts` imports each listed package's `src/internal/error-catalog.ts`, which Node runs as TypeScript, so no build is needed; the check renders the page again in memory and fails if the file differs. Run `pnpm run docs:errors` after changing a catalogue entry. The packages are listed in `CATALOGUED_PACKAGES`; a package under `packages/` that the script does not list fails the check, and so does a listed package without its catalogue.
- The [API reference](../user/reference/api/README.md) matches the TSDoc of the built packages. `scripts/generate-api-docs.ts` runs TypeDoc from `tools/api-docs` ([decision 0012](decisions/0012-api-reference-generator.md)) on the built `.d.ts` file of each export of `hardhat-kms`, listed from its `package.json`, and formats the pages with oxfmt; the check renders them again in a temporary directory and fails on a page that is missing, extra or different. TypeDoc treats its warnings as errors, such as a public type that refers to a type that is not exported, or a `{@link}` to something not documented. The pages have no "Defined in" links, which would print build paths. Run `pnpm run docs:api` after changing a TSDoc comment or a public type. The script runs `tsc -b` on the packages first, so the pages never come from a stale `dist/`, and runs TypeDoc in the C locale, so the anchors are the same under any system locale. The provider packages export only their plugin, so they have no page; the check fails if one exports anything else.
- First-party source builds its errors only through the catalogue helpers (`catalogError`, `catalogMessage`, `internalError`). The check parses each file with oxc-parser, so comments, strings and regular expressions cannot hide or fake a match, and fails, with the file and line, on: `kmsError` named anywhere outside its definition and export (a call, an import or an alias); `new HardhatPluginError(`; a `new` or a call of a class whose name, or last segment as in `ns.FooError`, ends in `Error`, `Failure` or `Exception`, without `catalogMessage` in its arguments; `new this.#x(…)` or `new obj.X(…)` with text in its arguments and no `catalogMessage`; and a thrown string. `src/internal/vendor/` is skipped.

[lychee](https://lychee.cli.rs) checks links, configured by `lychee.toml`. On every pull request the CI Docs job checks internal links and `#anchors` offline. A weekly workflow, `.github/workflows/docs-links.yml`, also checks external links, so a website that is briefly down cannot block a merge. To run the pull request check locally from the repository root:

```sh
docker run --rm -v "$PWD:/repo" -w /repo lycheeverse/lychee:0.24.2 --offline --config lychee.toml README.md AGENTS.md CLAUDE.md CONTRIBUTING.md SECURITY.md packages/hardhat-kms/THIRD_PARTY_NOTICES.md .github/pull_request_template.md 'packages/*/README.md' 'examples/README.md' 'examples/*/README.md' 'docs/**/*.md'
```

## Planned pages

The tracking issue for docs is [#38](https://github.com/aelmanaa/hardhat-kms/issues/38). Pages that do not exist yet:

- Guides: GitHub Actions with OIDC ([#68](https://github.com/aelmanaa/hardhat-kms/issues/68)).
- A docs site with `llms.txt` ([#74](https://github.com/aelmanaa/hardhat-kms/issues/74)).
