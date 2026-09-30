# 0010: Use pnpm workspaces

Status: Accepted (2026-10-01)

Issue: [#91](https://github.com/aelmanaa/hardhat-kms/issues/91)

## Context

With four packages that depend on each other (decision 0009), the repository needs a workspace tool. npm, pnpm and Yarn all support workspaces. Hardhat's own repository uses pnpm.

## Decision

Use pnpm workspaces, with the version pinned in `packageManager`:

- Packages refer to each other with `workspace:^`, which pnpm replaces with the released version when publishing.
- Shared development tools (TypeScript, oxlint, oxfmt and the rest) are pinned once, in the `catalog` of `pnpm-workspace.yaml`.
- CI installs pnpm with `pnpm/action-setup`, pinned by commit SHA like the other actions.

## Consequences

- pnpm does not hoist undeclared dependencies, so a package that imports something it did not declare fails in this repository's tests rather than in a user's project. This matters for provider packages, which must declare their SDK.
- The tests run under pnpm's strict layout, which many users of the plugin also use.
- Contributors need pnpm. pnpm switches to the version in `packageManager` by itself, and `npm i -g pnpm` installs it.
- Installs are faster and share one store on disk.
