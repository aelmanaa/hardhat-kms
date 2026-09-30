# 0006: A plugin-owned `kms` hook for third-party providers

Status: Accepted

## Context

The roadmap adds providers beyond the three built-in ones (Turnkey, Fireblocks, possibly PKCS#11 HSMs), and others may want providers the project does not ship. Tests also need a way to inject fake providers into a real Hardhat runtime.

## Decision

The plugin defines its own hook category, `kms`, with a `createKeyAdapter` hook. The built-in providers are its default handler. Other plugins and tests register handlers for their own provider ids. Unknown provider ids in the config pass schema validation as opaque objects, and the handler that claims the id validates them. An id that no handler claims is an error.

## Consequences

- A third-party provider ships as its own Hardhat plugin, with no change here.
- The provider contract in `hardhat-kms/types` must stay stable, so it is frozen before 1.0. The `kms` hook types are marked `@experimental`.
- Tests register fake providers with `hre.hooks.registerHandlers("kms", …)`; the package ships no public fake provider.

## Clarifications

- 2026-10-01, [0009](0009-one-package-per-provider.md): the first-party providers no longer form the default handler. Each ships as its own package and registers a `kms` handler like any other provider. A first-party key that no handler claims fails with an error that names the package to install.
