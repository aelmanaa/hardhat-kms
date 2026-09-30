# Migrate from Foundry

Audience: Foundry users moving KMS signing to Hardhat.

Status: Planned: M2.

## Foundry migration helper

Users coming from Foundry can keep their environment variables. The helper expands them into `kms.keys` entries:

```ts
import { kmsKeysFromFoundryEnv } from "hardhat-kms/foundry";
```

It reads these variables:

- `AWS_KMS_KEY_ID(S)`
- `GCP_PROJECT_ID`, `GCP_LOCATION`, `GCP_KEY_RING`, `GCP_KEY_NAME`, `GCP_KEY_VERSION`
- `AZURE_KEY_VAULT_KEY_ID(S)`

Lists are comma-split and trimmed, and blank entries are dropped. For single-value variables the helper emits `configVariable()`, so masking and lazy resolution work as they do for hand-written config. Only the comma-list expansion reads `process.env` directly; it is the one exception to the `node/no-process-env` lint rule. The README has the full mapping table.
