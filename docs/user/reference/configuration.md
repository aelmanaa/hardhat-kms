# Configuration reference

Audience: Users configuring the plugin.

Status: Planned: M2 (config), M3 and M6 (providers).

## Configuration

Keys are declared once under `kms.keys` and referenced by name from any network:

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKms from "hardhat-kms";

export default defineConfig({
  plugins: [hardhatKms],
  kms: {
    defaults: { aws: { region: "eu-west-1" }, timeoutMs: 30_000 },
    keys: {
      deployer: { provider: "aws", keyId: "alias/deployer", address: "0x1234…" }, // address pin: optional, recommended
      ops: { provider: "azure", keyId: "https://ops.vault.azure.net/keys/ops/0123abcd" },
      treasury: {
        provider: "gcp",
        keyVersionName: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/3",
      },
    },
  },
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      chainId: 11155111,
      kmsAccounts: ["deployer", "ops"],
    },
    arbitrum: {
      type: "http",
      url: configVariable("ARB_RPC_URL"),
      chainId: 42161,
      kmsAccounts: ["deployer"],
    },
    fork: {
      type: "edr-simulated",
      forking: { url: configVariable("SEPOLIA_RPC_URL") },
      kmsAccounts: ["deployer"],
    },
  },
});
```

A network's `kmsAccounts` lists key names or inline key objects. The full set of plugin config fields:

| Field                          | Meaning                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `kms.keys`                     | Named keys, reused across networks.                                                                                               |
| `kms.defaults.aws.region`      | Default AWS region (see the region precedence below).                                                                             |
| `kms.defaults.timeoutMs`       | Default per-call timeout. Default 30 s.                                                                                           |
| `kms.allowCrossChainTypedData` | Allow typed data whose `domain.chainId` differs from the connection's chain. Default `false`.                                     |
| `kms.simulatedBalance`         | A bigint in wei. On `edr-simulated` networks only, the plugin calls `hardhat_setBalance` for each KMS address on `newConnection`. |
| `networks.<name>.kmsAccounts`  | Key names or inline key objects for that network, on http and `edr-simulated` networks.                                           |
| `address` (per key)            | Optional address pin. Recommended: it avoids a KMS call to learn the address and guards against key substitution.                 |
| `timeoutMs` (per key)          | Overrides the default timeout for that key.                                                                                       |
| `approvalTimeoutMs`            | Timeout for providers with asynchronous approval flows, set alongside `timeoutMs`.                                                |

The plugin warns when `kmsAccounts` is set on the `default` network.

## Key forms per provider

The accepted key forms are a superset of Foundry's.

| Provider | Key forms                                                                                                                                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws`    | `keyId` as a key id, key ARN, alias name or alias ARN. Optional `region`, `profile`, `endpoint`.                                                                                                                 |
| `gcp`    | Either `keyVersionName`, or the components `projectId`, `location`, `keyRing`, `keyName`, `keyVersion`. The version is always required and never auto-selected.                                                  |
| `azure`  | Either `keyId` (the full URL, versioned or not, including `*.managedhsm.azure.net`), or `vaultUrl` + `keyName` + optional `keyVersion`. An unversioned key is resolved once and the resulting version is pinned. |

AWS resolves the region in this order: the region inside an ARN, then `key.region`, then `defaults.aws.region`, then the SDK's own chain. A configured region that conflicts with the ARN's region is an error. `AWS_ENDPOINT_URL_KMS` (useful for LocalStack) is left to the AWS SDK, which honours it.

Identifiers are not secrets. Every identifier field still accepts `string | ConfigurationVariable`. A value that came from a variable is displayed as `<VAR_NAME>` unless the user passes `--show-ids`.

Third-party providers extend the config types through the declaration-merged `KmsProviderUserConfigs` interface (see [Provider contract](../../contributor/providers.md#provider-contract)).

## Credentials

No secrets live in the Hardhat config. Each provider takes credentials from its SDK's default chain:

- AWS uses the SDK default chain: environment, then SSO/ini/profile, then process, then web identity, then IMDS/ECS.
- GCP uses Application Default Credentials.
- Azure builds the chain below, which follows the order used by Foundry's Azure Key Vault signer (service principal, workload identity, `az`/`azd`, managed identity).

```ts
new ChainedTokenCredential(
  EnvironmentCredential,
  WorkloadIdentityCredential,
  AzureCliCredential,
  AzureDeveloperCliCredential,
  ManagedIdentityCredential({ clientId: AZURE_CLIENT_ID }),
);
```

`AZURE_CLIENT_ID` selects a user-assigned managed identity. The managed identity `getToken` call has a 10 s timeout.
