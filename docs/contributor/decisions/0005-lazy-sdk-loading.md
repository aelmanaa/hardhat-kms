# 0005: Load cloud SDKs lazily from the user's project

Status: Superseded by [0009](0009-one-package-per-provider.md)

## Context

A project usually needs one provider, and the AWS, Google Cloud and Azure SDKs are large. Hardhat's peer dependency check ignores `peerDependenciesMeta`, so marking the SDKs as optional peer dependencies would not work.

## Decision

`hardhat` is the only peer dependency. Users install the SDK for their provider. The plugin resolves it from the project root on first use, checks its version against the range the provider declares, and fails with the exact install command when it is missing or incompatible. Provider descriptors, which the config hook imports, never import an SDK.

## Consequences

- Loading the config or running unrelated tasks never loads a cloud SDK.
- Installation has one extra step per provider, which each key setup guide will show.
- The cloud SDKs are development dependencies of the plugin, for its own tests.
