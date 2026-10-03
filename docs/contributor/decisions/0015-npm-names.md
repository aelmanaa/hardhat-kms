# 0015: npm names: an unscoped core and scoped providers

Status: Accepted (2026-10-03). Amends [0009](0009-one-package-per-provider.md).

Issue: [#206](https://github.com/aelmanaa/hardhat-kms/issues/206)

## Context

[Decision 0009](0009-one-package-per-provider.md) split the plugin into a core and one package per cloud provider, and named the providers with a `hardhat-kms-` prefix. Nothing had been published under those names when this record was written.

Anyone can publish an unscoped package. A `hardhat-kms-fireblocks` published by someone else would look like part of this project, and npm's terms forbid holding a name with a placeholder package ([disputes policy](https://docs.npmjs.com/policies/disputes)), so this project could not claim the names of providers it has not written yet. Only members of the `hardhat-kms` npm organization can publish under the `@hardhat-kms/` scope. These packages sign with production keys, so a lookalike package is an attack path.

Hardhat finds a plugin's `package.json` through `npmPackage ?? id` after a load error, prints `npmPackage` in its unused-plugin warning, and prints the plugin id in `Plugin "{pluginId}" is not installed.` and in its peer-dependency errors. An id that differs from the package name would send users to a name this project does not own. `@nomicfoundation/hardhat-foundry` uses its scoped package name as its id.

## Decision

| Package                                  | npm name             | Plugin id            |
| ---------------------------------------- | -------------------- | -------------------- |
| Core                                     | `hardhat-kms`        | `hardhat-kms`        |
| AWS KMS provider                         | `@hardhat-kms/aws`   | `@hardhat-kms/aws`   |
| Google Cloud KMS provider                | `@hardhat-kms/gcp`   | `@hardhat-kms/gcp`   |
| Azure Key Vault and Managed HSM provider | `@hardhat-kms/azure` | `@hardhat-kms/azure` |

The core keeps its unscoped name, and its id stays `hardhat-kms`: the id is also the `HardhatPluginError` plugin id, the debug namespace and the user-agent tag. Every first-party provider is published as `@hardhat-kms/<id>`, where `<id>` is its provider id, and its plugin `id` and `npmPackage` equal that name. Later first-party providers follow the same rule, for example `@hardhat-kms/turnkey`.

The official packages are `hardhat-kms` and the packages under the `@hardhat-kms` npm scope. A third-party provider publishes under its own name or scope, without a `hardhat-kms-` prefix, so users can tell it apart.

The directories under `packages/` keep their names (`packages/hardhat-kms-aws` and so on). No install or import uses them, and the CI path filters and module-URL checks in the tests depend on them.

The rest of 0009 stands: four packages, released together at the same version as one changesets `fixed` group. One correction to its consequences: Hardhat's unused-plugin warning names a plugin that the config imports but leaves out of `plugins`, not a provider that has no key in the config.

## Consequences

- Users have one rule to check before installing: `hardhat-kms` or `@hardhat-kms/*`.
- The `hardhat-kms` npm organization must exist, and the publishing account must be an owner, before the first release.
- Install commands in error messages and docs name the scoped packages, such as `npm install --save-dev @hardhat-kms/aws`.
- A tarball of `@hardhat-kms/aws` is still named `hardhat-kms-aws-<version>.tgz`, so a check of a packed name reads the `package.json` inside the tarball.
- `pnpm --filter` with a name that matches no package exits 0. Every `--filter` in the root scripts and in `scripts/` passes `--fail-if-no-match`, so a stale name fails instead of skipping its tests.
- Until the first publish, anyone can still publish the unscoped `hardhat-kms` before this project does.
- If npm refuses the unscoped `hardhat-kms` at first publish, the core becomes `@hardhat-kms/core`, and the official-packages rule shrinks to the `@hardhat-kms` scope. That would be a reason to revisit this record.
