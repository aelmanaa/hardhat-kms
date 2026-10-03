# 0009: Ship each cloud provider as its own package

Status: Accepted (2026-10-01). Supersedes [0005](0005-lazy-sdk-loading.md).

Amended by [0015](0015-npm-names.md): the provider packages are named `@hardhat-kms/aws`, `@hardhat-kms/gcp` and `@hardhat-kms/azure`, and 0015 corrects this record's note on Hardhat's unused-plugin warning.

Issue: [#91](https://github.com/aelmanaa/hardhat-kms/issues/91)

## Context

Decision 0005 kept every cloud SDK out of the plugin's dependencies: users installed the SDK for their provider, and the plugin loaded it from their project. That kept installs small, but it made the plugin declare supported SDK ranges it could not fully test. The AWS review found the cost: `@aws-sdk/client-kms` releases before 3.714.0 ignore the region of a named profile, and the declared range `^3.0.0` allowed them.

Depending on all three SDKs from one package would fix the ranges but grow every project. Measured on 2026-10-01 with npm:

| Installed                                               | Size                 |
| ------------------------------------------------------- | -------------------- |
| `hardhat` 3.18.0                                        | 91 MB, 50 packages   |
| `@aws-sdk/client-kms` 3.1144.0                          | 15 MB                |
| `@google-cloud/kms` 6.2.1                               | 38 MB                |
| `@azure/keyvault-keys` 4.10.2, `@azure/identity` 4.13.3 | 48 MB                |
| All three SDKs                                          | 101 MB, 142 packages |

Hardhat 3 supports plugins that depend on plugins: `hardhat-toolbox-viem` is a list of other plugins, declared in `package.json` and in the plugin's `dependencies`, which Hardhat loads first (`hardhat` `src/internal/core/plugins/resolve-plugin-list.ts`).

## Decision

Publish four packages from one repository:

- `hardhat-kms`, the core: config, key formats of the first-party providers, the signing checks, the `kms` hook and `--kms`. It depends on no cloud SDK.
- `hardhat-kms-aws`, `hardhat-kms-gcp` and `hardhat-kms-azure`: each holds its provider's adapter, depends on its SDK at versions this project tests, and adds the adapter through the `kms` hook.

Each provider package lists `hardhat-kms` in its plugin `dependencies`, so a user adds only the provider to `plugins`, and as a `peerDependency`, so a project has one copy of the core. The four packages are released together at the same version.

The core keeps the first-party key formats, so `provider: "aws"` is validated even when `hardhat-kms-aws` is missing. Using such a key without its package fails with the install command.

## Consequences

- A project installs one SDK, at a version this project tests. Dependabot keeps it current; a range starts at a tested version.
- There is no separate SDK install step, and SDKs load like any dependency. The runtime resolution from the project root (`loadSdk`) is no longer needed by first-party providers.
- Two copies of `hardhat-kms` in one project make Hardhat stop with `Duplicated plugin id "hardhat-kms" found`. The peer dependency prevents it, and Hardhat's plugin peer check reports version mismatches.
- Four packages to version, build and publish; changesets releases them as one fixed group.
- Hardhat warns about a plugin in `plugins` that nothing uses, for example `hardhat-kms-aws` without an AWS key.
