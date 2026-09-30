# 0007: oxlint, oxfmt and TypeScript 7

Status: Accepted

## Context

The pre-commit hook formats, lints and typechecks every commit, so those tools must be fast. The project also wants type-aware lint rules such as `no-floating-promises` and the `no-unsafe-*` family, which in ESLint need typescript-eslint and a full type-checked program.

## Decision

Use oxlint with type-aware rules (through `oxlint-tsgolint`), oxfmt for formatting, and the native TypeScript 7 compiler. Keep `eslint-plugin-jsdoc` through oxlint's JavaScript plugin support, to require TSDoc on every export. Pin all three exactly and let Dependabot propose upgrades.

## Consequences

- The pre-commit hook can run format, lint and typecheck on every commit.
- The published types are checked on TypeScript 5.9, 6.0 and 7.0 by a consumer typecheck in CI, since users may not be on TypeScript 7.
- oxlint does not implement every ESLint rule. A missing rule is added through a JavaScript plugin or accepted as a gap.
