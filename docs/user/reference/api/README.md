---
title: API reference
description: "The TypeScript API of hardhat-kms: the plugin export, the config types, the helpers for provider plugins, the Alchemy prepared-call check and @hardhat-kms/safe."
---

# API reference

Audience: anyone who imports from `hardhat-kms` in TypeScript, or writes a provider package.

These pages are generated from the documentation comments of the published type declarations, so they describe the code of this version. Anything marked `Experimental` is outside the public API and may change in a minor.

The plugin is configured, not called: [Configuration](../configuration.md) describes each config field. The provider packages export only their plugin, so they have no page here. `@hardhat-kms/safe` exports its plugin and `proposeSafeTransaction`, which proposes Safe transactions from code.

## Modules

- [@hardhat-kms/safe](@hardhat-kms/safe.md)
- [hardhat-kms](hardhat-kms.md)
- [hardhat-kms/alchemy](hardhat-kms/alchemy.md)
- [hardhat-kms/provider-utils](hardhat-kms/provider-utils.md)
- [hardhat-kms/types](hardhat-kms/types.md)
