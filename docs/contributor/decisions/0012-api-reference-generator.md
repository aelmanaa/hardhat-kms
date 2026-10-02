# 0012: Generate the API reference with TypeDoc on TypeScript 6

Status: Accepted (2026-10-01)

Issue: [#73](https://github.com/aelmanaa/hardhat-kms/issues/73)

## Context

The public API of `hardhat-kms` (`.`, `./types` and `./provider-utils`) is documented in TSDoc, and the reference pages should be generated from it. In `./types`, the `kms` hook and the adapter contract are marked `@experimental`; the whole of `./provider-utils` is, including the error catalogue helpers (`catalogError`, `catalogMessage`, `internalError` and their types), which only the first-party provider packages use. Two reference pages already exist: the [errors reference](../../user/reference/errors.md), generated from the error catalogues ([#72](https://github.com/aelmanaa/hardhat-kms/issues/72)), and the [provider contract](../providers.md), whose interface block `docs:check` typechecks against `hardhat-kms/types` ([#174](https://github.com/aelmanaa/hardhat-kms/issues/174)). The repository compiles with TypeScript 7.0.2 (decision 0007). That package exposes the compiler API only under `typescript/unstable/*`, so a tool that imports `typescript` cannot use it.

The two candidates, at their latest versions on 2026-10-01:

| Tool                              | TypeScript it runs on                                                           | TypeScript 7 support           |
| --------------------------------- | ------------------------------------------------------------------------------- | ------------------------------ |
| TypeDoc 0.28.20                   | The project's own, through a `typescript` peer dependency, range 5.0.x to 6.0.x | Open: TypeStrong/typedoc#3098  |
| `@microsoft/api-extractor` 7.59.3 | Its own TypeScript 5.9.3, a regular dependency, whatever the project uses       | Open: microsoft/rushstack#6033 |

Microsoft publishes TypeScript 6 for projects that have moved to 7 as `@typescript/typescript6`. Version 6.0.2 provides a `tsc6` command and re-exports the TypeScript 6 API from its main entry, through a dependency on `typescript@^6` (resolved to 6.0.3 on 2026-10-01). Aliasing `typescript` to it gives TypeDoc a TypeScript 6 without changing the TypeScript of the rest of the workspace. Another project already uses the same split: its API reference site runs TypeDoc 0.28.20 on TypeScript 6 through this package, while its libraries compile with TypeScript 7.

## Evidence

Checked by execution on 2026-10-01, Node 24.16.0, against `main` at `eaa38d7`:

1. `pnpm run build` in the repository, with TypeScript 7.0.2.
2. In a scratch directory outside the repository: `typedoc@0.28.20`, `typedoc-plugin-markdown@4.13.1` and `typescript@npm:@typescript/typescript6@6.0.2`. `typedoc --version` reported "Using TypeScript 6.0.3".
3. TypeDoc ran on `packages/hardhat-kms/dist/src/index.d.ts`, `types.d.ts` and `provider-utils.d.ts`, with `--outputFileStrategy modules`, `--disableSources` and `--treatWarningsAsErrors`. It exited without warnings and wrote one Markdown page per entry point plus an index (five files).
4. The pages contained no "Defined in" lines and no file-system or `node_modules` paths. The `@experimental` tags showed on `types` and `provider-utils`.

Rechecked on 2026-10-02 against `main` at `cbec96a`, with the same versions and options:

5. With `--treatWarningsAsErrors`, TypeDoc stopped on four warnings, all from the catalogue helpers that `./provider-utils` gained after `eaa38d7`. `TemplateParams` refers to three types that are not exported (`Complete`, `UnionToIntersection` and `PlaceholderValues`), and its comment links to `fillTemplate`, which is not exported either.
6. Without that option, it wrote the same five files. They still had no "Defined in" lines and no file-system or `node_modules` paths, and the `@experimental` tags showed on `types` and `provider-utils`.

An earlier spike on 2026-10-01 ran API Extractor 7.59.3 on the same three entry points. All three passed, with TSDoc syntax warnings on two comments in `internal/crypto/public-key.d.ts` (an unescaped `}`). It analyses one entry point per run. TypeDoc without `--disableSources` printed "Defined in" lines with build paths and a `node_modules` path.

## Decision

Generate the API reference with TypeDoc and `typedoc-plugin-markdown`, from a private workspace package such as `tools/api-docs`:

- The package's devDependencies alias `typescript` to `npm:@typescript/typescript6@6.0.2`. TypeDoc resolves TypeScript 6 there; the root and every published package keep compiling with TypeScript 7.
- TypeDoc runs on the built `.d.ts` files, not on the sources.
- The "Defined in" source links are off (`disableSources`), since they expose build and `node_modules` paths.
- The snippet typecheck in `docs:check` skips the generated pages. Their code blocks are signatures, not programs.

API Extractor is not chosen now. It analyses with its bundled TypeScript 5.9, so its view of the types can lag the compiler that builds them, and it waits on microsoft/rushstack#6033 for TypeScript 7. Its strength is an API report that gates public-API changes, a separate need from reference pages. That gate can be proposed on its own before 1.0.

## Consequences

- The workspace holds two TypeScript versions. TypeScript 6 lives only in the tools package, which is private and never published.
- The `.d.ts` files TypeDoc reads are the ones CI already typechecks on TypeScript 5.9, 6.0 and 7.0, so TypeScript 6 reading them is a supported case.
- The alias pins the wrapper, not the TypeScript inside it: `@typescript/typescript6` depends on `typescript@^6`, and the lockfile holds the exact version. A TypeScript 6 patch arrives through a lockfile update.
- The generated pages must be rebuilt after `pnpm run build`, since they depend on `dist/`.
- The four warnings in Evidence item 5 must be cleared before the run can treat warnings as errors, for example by exporting the helper types or by removing the `fillTemplate` link from the `TemplateParams` comment.
- The errors reference shows how a generated page is kept current: a script writes it, and `docs:check` renders it again and fails when the committed file differs. The API pages can follow the same pattern.
- `docs:check` requires every page under `docs/` to be linked from `AGENTS.md` and `docs/README.md`. The generated pages need those links, or an exception in `checkIndexes`.
- The provider contract page stays hand-written. Its typechecked block cannot drift from `hardhat-kms/types`, and it explains what the generated `types` page does not: which adapter method the core calls for each request, and the rules an adapter follows.
- Revisit when TypeDoc supports TypeScript 7 (TypeStrong/typedoc#3098). Then drop the alias and let the tools package use the workspace TypeScript.
